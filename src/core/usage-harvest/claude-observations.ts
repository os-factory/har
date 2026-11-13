import * as fs from 'fs';
import * as path from 'path';
import type { UsageObservation } from '../../harness/schema';
import { workspaceMatchesTarget } from '../workspace-path-match';
import { claudeProjectsRoot, encodeClaudeProjectDir, readJsonlRecords } from './claude';

/**
 * Claude Code usage observations harvested from session transcripts (ADR 0003).
 *
 * One observation per API response: Claude Code splits one assistant message
 * over several transcript records and repeats its `usage` on each, so records
 * are grouped by `message.id`. The observation key is the record's `requestId`
 * — the same id Claude's native OTLP `claude_code.api_request` event carries as
 * `request_id` — so a harvested observation and a live one are the same fact
 * to Mission Control. Subagents write their own transcript,
 * `<session>/subagents/agent-<agentId>.jsonl`, whose records carry `agentId`.
 */

/** Claude Code session ids are UUIDs; anything else is never joined into a path. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

export interface ClaudeSessionFiles {
  /** The project folder the session's transcript was filed under. */
  projectDir: string;
  transcript: string;
  subagentTranscripts: string[];
}

/** `~/.claude/projects/<any project>/<sessionId>.jsonl` and its subagent transcripts. */
export function findClaudeSessionFiles(sessionId: string): ClaudeSessionFiles | null {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  const root = claudeProjectsRoot();
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(root, entry.name);
    const transcript = path.join(projectDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(transcript)) continue;
    const subagentsDir = path.join(projectDir, sessionId, 'subagents');
    const subagentTranscripts = fs.existsSync(subagentsDir)
      ? fs
          .readdirSync(subagentsDir)
          .filter((name) => /^agent-.+\.jsonl$/.test(name))
          .sort()
          .map((name) => path.join(subagentsDir, name))
      : [];
    return { projectDir, transcript, subagentTranscripts };
  }
  return null;
}

interface AssistantRecord {
  timestamp?: unknown;
  requestId?: unknown;
  agentId?: unknown;
  isSidechain?: unknown;
  message?: {
    id?: unknown;
    model?: unknown;
    usage?: Record<string, unknown>;
  };
}

function count(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Observations from one transcript's records. `subagentId` is the transcript's
 * agent (from its file name) when records do not carry `agentId` themselves.
 */
export function claudeObservationsFromRecords(
  sessionId: string,
  records: unknown[],
  subagentId?: string,
): UsageObservation[] {
  // Later records of a split message carry the final usage; keep the last.
  const byMessage = new Map<string, AssistantRecord>();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const payload = record as AssistantRecord & { type?: unknown };
    if (payload.type !== 'assistant') continue;
    const usage = payload.message?.usage;
    if (!usage || typeof usage !== 'object') continue;
    const messageId = typeof payload.message?.id === 'string' ? payload.message.id : null;
    const requestId = typeof payload.requestId === 'string' ? payload.requestId : null;
    const key = messageId ?? requestId;
    if (!key) continue;
    byMessage.set(key, payload);
  }

  const out: UsageObservation[] = [];
  for (const [messageId, record] of byMessage) {
    const model = typeof record.message?.model === 'string' ? record.message.model : undefined;
    // `<synthetic>` messages are written by Claude Code itself, not billed.
    if (model === '<synthetic>') continue;
    const observedAt = isoTimestamp(record.timestamp);
    if (!observedAt) continue;
    const usage = record.message?.usage ?? {};
    const tokensInput = count(usage.input_tokens);
    const tokensOutput = count(usage.output_tokens);
    const tokensCacheRead = count(usage.cache_read_input_tokens);
    const tokensCacheCreation = count(usage.cache_creation_input_tokens);
    if (tokensInput + tokensOutput + tokensCacheRead + tokensCacheCreation === 0) continue;
    const recordAgent =
      typeof record.agentId === 'string' && record.agentId ? record.agentId : undefined;
    const agent = recordAgent ?? subagentId;
    out.push({
      agentTool: 'claude_code',
      sessionId,
      ...(agent ? { subagentId: agent } : {}),
      observationKey:
        typeof record.requestId === 'string' && record.requestId ? record.requestId : messageId,
      observedAt,
      granularity: 'request',
      source: 'harvest',
      ...(model ? { model } : {}),
      tokensInput,
      tokensOutput,
      tokensCacheRead,
      tokensCacheCreation,
    });
  }
  return out.sort((a, b) => a.observedAt.localeCompare(b.observedAt));
}

function subagentIdFromFile(file: string): string | undefined {
  const match = path.basename(file).match(/^agent-(.+)\.jsonl$/);
  return match ? match[1] : undefined;
}

/** Every billed request of one Claude session, its subagents included. */
export function harvestClaudeSessionObservations(sessionId: string): UsageObservation[] {
  const files = findClaudeSessionFiles(sessionId);
  if (!files) return [];
  const seen = new Set<string>();
  const out: UsageObservation[] = [];
  const sources: Array<{ file: string; subagentId?: string }> = [
    { file: files.transcript },
    ...files.subagentTranscripts.map((file) => ({ file, subagentId: subagentIdFromFile(file) })),
  ];
  for (const { file, subagentId } of sources) {
    for (const observation of claudeObservationsFromRecords(
      sessionId,
      readJsonlRecords(file),
      subagentId,
    )) {
      if (seen.has(observation.observationKey)) continue;
      seen.add(observation.observationKey);
      out.push(observation);
    }
  }
  return out;
}

/** A Claude session that itself runs inside a slot's work dir. */
export interface ClaudeWorkspaceSession {
  sessionId: string;
  workDir: string;
  /** First record of the session inside the work dir. */
  firstAt: string;
}

/**
 * Claude sessions whose transcript `cwd` is inside one of `workDirs`. Claude
 * files a session under its launch cwd, encoded (`/` and `.` both become `-`),
 * so only folders whose name starts with an encoded work dir are read; the
 * records' `cwd` confirms the match.
 */
export function findClaudeSessionsInWorkDirs(workDirs: string[]): ClaudeWorkspaceSession[] {
  const targets = [...new Set(workDirs.filter(Boolean).map((dir) => path.resolve(dir)))];
  if (targets.length === 0) return [];
  const root = claudeProjectsRoot();
  if (!fs.existsSync(root)) return [];
  const encoded = targets.map((dir) => encodeClaudeProjectDir(dir));
  const out = new Map<string, ClaudeWorkspaceSession>();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!encoded.some((prefix) => entry.name === prefix || entry.name.startsWith(`${prefix}-`))) {
      continue;
    }
    const projectDir = path.join(root, entry.name);
    for (const file of fs.readdirSync(projectDir)) {
      if (!file.endsWith('.jsonl')) continue;
      for (const record of readJsonlRecords(path.join(projectDir, file))) {
        if (!record || typeof record !== 'object') continue;
        const { cwd, sessionId, timestamp } = record as {
          cwd?: unknown;
          sessionId?: unknown;
          timestamp?: unknown;
        };
        if (typeof cwd !== 'string' || !cwd) continue;
        const workDir = targets.find((target) => workspaceMatchesTarget(cwd, [target]));
        const at = isoTimestamp(timestamp);
        if (!workDir || !at) continue;
        const id =
          typeof sessionId === 'string' && sessionId ? sessionId : file.slice(0, -'.jsonl'.length);
        if (!out.has(id)) out.set(id, { sessionId: id, workDir, firstAt: at });
        break;
      }
    }
  }
  return [...out.values()];
}
