import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { UsageObservation } from '../../harness/schema';
import { workspaceMatchesTarget } from '../workspace-path-match';

/**
 * Codex usage observations harvested from rollouts (ADR 0003).
 *
 * A rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`) is
 * one thread. Its first record, `session_meta`, carries the thread id (the
 * `CODEX_THREAD_ID` Codex gives every command it runs), the cwd, and for a
 * spawned subagent `source.subagent.thread_spawn.parent_thread_id`. Each model
 * response appends an `event_msg` / `token_count` whose `info.last_token_usage`
 * is that response's usage; Codex re-emits `token_count` with unchanged totals
 * (rate-limit updates), so only events that move `total_token_usage` count.
 * Responses are summed per turn — `turn_id` of `task_started` / `turn_context`
 * — and one observation is emitted per turn, keyed by the turn id.
 *
 * Codex's `input_tokens` includes `cached_input_tokens` and its
 * `output_tokens` includes `reasoning_output_tokens`; observations split cached
 * input out (`tokensCacheRead`) and never add reasoning on top of output.
 */

export function codexSessionsRoot(): string {
  return process.env.HAR_CODEX_SESSIONS_DIR
    ? path.resolve(process.env.HAR_CODEX_SESSIONS_DIR)
    : path.join(os.homedir(), '.codex', 'sessions');
}

export interface CodexRollout {
  threadId: string;
  file: string;
  cwd?: string;
  startedAt?: string;
  /** Set for a spawned subagent thread. */
  parentThreadId?: string;
}

function walkJsonlFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonlFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/** The first line of a file, read in chunks (session_meta embeds the base instructions). */
function readFirstLine(file: string, maxBytes = 4 * 1024 * 1024): string | null {
  const fd = fs.openSync(file, 'r');
  try {
    const chunk = Buffer.alloc(64 * 1024);
    const parts: Buffer[] = [];
    let total = 0;
    while (total < maxBytes) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, total);
      if (read === 0) break;
      const newline = chunk.subarray(0, read).indexOf(0x0a);
      if (newline >= 0) {
        parts.push(Buffer.from(chunk.subarray(0, newline)));
        return Buffer.concat(parts).toString('utf8');
      }
      parts.push(Buffer.from(chunk.subarray(0, read)));
      total += read;
    }
    return parts.length > 0 ? Buffer.concat(parts).toString('utf8') : null;
  } finally {
    fs.closeSync(fd);
  }
}

function isoTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export function parseCodexSessionMeta(line: string, file: string): CodexRollout | null {
  let record: { type?: unknown; timestamp?: unknown; payload?: Record<string, unknown> };
  try {
    record = JSON.parse(line) as typeof record;
  } catch {
    return null;
  }
  if (record?.type !== 'session_meta' || !record.payload) return null;
  const payload = record.payload;
  const threadId = typeof payload.id === 'string' && payload.id ? payload.id : null;
  if (!threadId) return null;
  const source = payload.source as
    { subagent?: { thread_spawn?: { parent_thread_id?: unknown } } } | undefined;
  const parent = source?.subagent?.thread_spawn?.parent_thread_id;
  return {
    threadId,
    file,
    ...(typeof payload.cwd === 'string' && payload.cwd ? { cwd: payload.cwd } : {}),
    ...(isoTimestamp(payload.timestamp ?? record.timestamp)
      ? { startedAt: isoTimestamp(payload.timestamp ?? record.timestamp) }
      : {}),
    ...(typeof parent === 'string' && parent ? { parentThreadId: parent } : {}),
  };
}

/** Every rollout under the Codex sessions root, by thread id. */
export function indexCodexRollouts(root = codexSessionsRoot()): Map<string, CodexRollout> {
  const index = new Map<string, CodexRollout>();
  for (const file of walkJsonlFiles(root)) {
    let line: string | null;
    try {
      line = readFirstLine(file);
    } catch {
      continue;
    }
    const rollout = line ? parseCodexSessionMeta(line, file) : null;
    if (rollout && !index.has(rollout.threadId)) index.set(rollout.threadId, rollout);
  }
  return index;
}

/**
 * The session a thread's usage belongs to: a spawned subagent thread is a
 * subagent of its root thread (the one whose id its parent agent's commands
 * carry); any other thread is its own session.
 */
export function codexSessionRef(
  threadId: string,
  index: Map<string, CodexRollout>,
): { sessionId: string; subagentId?: string } {
  let root = threadId;
  const visited = new Set<string>([root]);
  for (;;) {
    const parent = index.get(root)?.parentThreadId;
    if (!parent || visited.has(parent)) break;
    visited.add(parent);
    root = parent;
  }
  return root === threadId ? { sessionId: threadId } : { sessionId: root, subagentId: threadId };
}

interface TokenUsage {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_write_input_tokens?: unknown;
  output_tokens?: unknown;
  total_tokens?: unknown;
}

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

interface TurnTotals {
  key: string;
  model?: string;
  observedAt: string;
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

/** One observation per turn of a rollout's records. */
export function codexObservationsFromRecords(
  ref: { sessionId: string; subagentId?: string },
  records: unknown[],
): UsageObservation[] {
  const turns = new Map<string, TurnTotals>();
  let turnKey: string | undefined;
  let turnOrdinal = 0;
  let model: string | undefined;
  let lastTotal = -1;
  // Rollouts written before turn ids existed: number turns in order.
  const nextOrdinalKey = (): string => {
    turnOrdinal += 1;
    return `turn-${turnOrdinal}`;
  };
  const idOf = (value: unknown): string | undefined =>
    typeof value === 'string' && value ? value : undefined;

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const { type, payload, timestamp } = record as {
      type?: unknown;
      payload?: Record<string, unknown>;
      timestamp?: unknown;
    };
    if (!payload || typeof payload !== 'object') continue;
    if (type === 'event_msg' && payload.type === 'task_started') {
      turnKey = idOf(payload.turn_id) ?? nextOrdinalKey();
      continue;
    }
    if (type === 'turn_context') {
      const id = idOf(payload.turn_id);
      if (id) turnKey = id;
      else if (!turnKey || turns.has(turnKey)) turnKey = nextOrdinalKey();
      if (typeof payload.model === 'string' && payload.model) model = payload.model;
      continue;
    }
    if (type !== 'event_msg' || payload.type !== 'token_count') continue;
    const info = payload.info as
      { total_token_usage?: TokenUsage; last_token_usage?: TokenUsage } | null | undefined;
    const last = info?.last_token_usage;
    if (!last) continue;
    if (info?.total_token_usage) {
      const total = count(info.total_token_usage.total_tokens);
      if (total === lastTotal) continue;
      lastTotal = total;
    }
    const observedAt = isoTimestamp(timestamp);
    if (!observedAt) continue;
    const key = turnKey ?? (turnKey = nextOrdinalKey());
    const turn = turns.get(key) ?? {
      key,
      observedAt,
      input: 0,
      cached: 0,
      cacheWrite: 0,
      output: 0,
    };
    const input = count(last.input_tokens);
    const cached = Math.min(count(last.cached_input_tokens), input);
    turn.input += input - cached;
    turn.cached += cached;
    turn.cacheWrite += count(last.cache_write_input_tokens);
    turn.output += count(last.output_tokens);
    turn.observedAt = observedAt;
    if (model) turn.model = model;
    turns.set(key, turn);
  }

  return [...turns.values()]
    .filter((turn) => turn.input + turn.cached + turn.cacheWrite + turn.output > 0)
    .map((turn) => ({
      agentTool: 'codex' as const,
      sessionId: ref.sessionId,
      ...(ref.subagentId ? { subagentId: ref.subagentId } : {}),
      observationKey: turn.key,
      observedAt: turn.observedAt,
      granularity: 'turn' as const,
      source: 'harvest' as const,
      ...(turn.model ? { model: turn.model } : {}),
      tokensInput: turn.input,
      tokensOutput: turn.output,
      tokensCacheRead: turn.cached,
      tokensCacheCreation: turn.cacheWrite,
    }));
}

function readJsonl(file: string): unknown[] {
  const out: unknown[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip bad lines
    }
  }
  return out;
}

/**
 * Observations of the given sessions (root thread ids), their spawned subagent
 * threads included.
 */
export function harvestCodexSessionObservations(
  sessionIds: Iterable<string>,
  index: Map<string, CodexRollout>,
): UsageObservation[] {
  const wanted = new Set(sessionIds);
  if (wanted.size === 0) return [];
  const out: UsageObservation[] = [];
  for (const rollout of index.values()) {
    const ref = codexSessionRef(rollout.threadId, index);
    if (!wanted.has(ref.sessionId)) continue;
    try {
      out.push(...codexObservationsFromRecords(ref, readJsonl(rollout.file)));
    } catch {
      // unreadable rollout
    }
  }
  return out;
}

/** A Codex thread started inside a slot's work dir. */
export interface CodexWorkspaceSession {
  sessionId: string;
  subagentId?: string;
  workDir: string;
  firstAt: string;
}

export function findCodexSessionsInWorkDirs(
  workDirs: string[],
  index: Map<string, CodexRollout>,
): CodexWorkspaceSession[] {
  const targets = [...new Set(workDirs.filter(Boolean).map((dir) => path.resolve(dir)))];
  if (targets.length === 0) return [];
  const out: CodexWorkspaceSession[] = [];
  for (const rollout of index.values()) {
    if (!rollout.cwd || !rollout.startedAt) continue;
    const cwd = rollout.cwd;
    const workDir = targets.find((target) => workspaceMatchesTarget(cwd, [target]));
    if (!workDir) continue;
    out.push({ ...codexSessionRef(rollout.threadId, index), workDir, firstAt: rollout.startedAt });
  }
  return out;
}
