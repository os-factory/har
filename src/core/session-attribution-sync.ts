import * as path from 'path';
import { resolveHarnessRoot } from '../harness/manifest';
import {
  SessionSlotBindingSchema,
  type AgentSlotStatus,
  type AgentTool,
  type SessionSlotBinding,
  type UsageObservation,
} from '../harness/schema';
import { listSessionBindings, sessionBindingKey, slotOccupancyKey } from './session-bindings';
import {
  findClaudeSessionsInWorkDirs,
  harvestClaudeSessionObservations,
} from './usage-harvest/claude-observations';
import {
  codexSessionRef,
  findCodexSessionsInWorkDirs,
  harvestCodexSessionObservations,
  indexCodexRollouts,
  type CodexRollout,
} from './usage-harvest/codex-observations';

/**
 * What `har control sync` sends for session → slot attribution (ADR 0003):
 * the `launch` / `release` bindings HAR recorded, `workspace` bindings for
 * sessions that run inside a slot's work dir, and the usage observations of
 * every session the repo has evidence for. Observations are never assigned a
 * slot here — Mission Control derives that from the binding timeline.
 */

export type AttributionSlot = Pick<
  AgentSlotStatus,
  'agentId' | 'active' | 'workDir' | 'worktreePath' | 'branch' | 'attemptId' | 'sessionCreatedAt'
>;

/** Bindings recorded in every source checkout (main + session worktrees), deduplicated. */
export function collectLocalSessionBindings(sourcePaths: string[]): SessionSlotBinding[] {
  const byKey = new Map<string, SessionSlotBinding>();
  for (const source of sourcePaths) {
    for (const binding of listSessionBindings(resolveHarnessRoot(source))) {
      byKey.set(sessionBindingKey(binding), binding);
    }
  }
  return [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * A Codex subagent thread runs commands with its own `CODEX_THREAD_ID`, but its
 * usage is reported as a subagent of the root thread; bind it the same way.
 */
export function normalizeCodexBinding(
  binding: SessionSlotBinding,
  index: Map<string, CodexRollout>,
): SessionSlotBinding {
  if (binding.agentTool !== 'codex' || binding.subagentId) return binding;
  const ref = codexSessionRef(binding.sessionId, index);
  return ref.subagentId ? { ...binding, ...ref } : binding;
}

function laterOf(a: string, b: string | undefined): string {
  if (!b) return a;
  const bMs = Date.parse(b);
  if (!Number.isFinite(bMs)) return a;
  return Date.parse(a) >= bMs ? a : new Date(bMs).toISOString();
}

interface WorkspaceSession {
  agentTool: AgentTool;
  sessionId: string;
  subagentId?: string;
  workDir: string;
  firstAt: string;
}

/**
 * `workspace` bindings: the session itself runs inside an active slot's work
 * dir, from its first record there (never before the occupancy began).
 */
export function workspaceBindings(
  slots: AttributionSlot[],
  sessions: WorkspaceSession[],
): SessionSlotBinding[] {
  const out: SessionSlotBinding[] = [];
  for (const session of sessions) {
    const slot = slots.find(
      (candidate) =>
        candidate.active &&
        [candidate.workDir, candidate.worktreePath].some(
          (dir) => dir && path.resolve(dir) === path.resolve(session.workDir),
        ),
    );
    if (!slot) continue;
    const occupancyKey = slotOccupancyKey({
      attemptId: slot.attemptId,
      branch: slot.branch,
      createdAt: slot.sessionCreatedAt ?? '',
      worktreePath: slot.worktreePath,
      workDir: slot.workDir ?? '',
    });
    const parsed = SessionSlotBindingSchema.safeParse({
      agentTool: session.agentTool,
      sessionId: session.sessionId,
      ...(session.subagentId ? { subagentId: session.subagentId } : {}),
      kind: 'workspace',
      slotId: slot.agentId,
      ...(occupancyKey ? { occupancyKey } : {}),
      ...(slot.branch ? { branch: slot.branch } : {}),
      at: laterOf(session.firstAt, slot.sessionCreatedAt),
    });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export interface SessionAttributionPayload {
  bindings: SessionSlotBinding[];
  observations: UsageObservation[];
}

/**
 * Bindings and observations for one repository.
 *
 * Sessions harvested: every session with a binding in this repo — recorded
 * locally, or known to Mission Control (`remoteBindings`, e.g. `observed`
 * from otel-hook spans) — plus sessions running inside an active slot's work
 * dir. Usage of a bound session from before its first binding is included on
 * purpose: Mission Control shows it as the session's unassigned (main
 * checkout) usage.
 */
export function collectSessionAttribution(options: {
  sourcePaths: string[];
  slots: AttributionSlot[];
  remoteBindings?: SessionSlotBinding[];
  /** Read transcripts / rollouts (telemetry on). Bindings are sent either way. */
  harvest: boolean;
}): SessionAttributionPayload {
  const local = collectLocalSessionBindings(options.sourcePaths);
  if (!options.harvest) {
    return { bindings: local, observations: [] };
  }

  const codexIndex = indexCodexRollouts();
  const workDirs = options.slots
    .filter((slot) => slot.active)
    .flatMap((slot) => [slot.workDir, slot.worktreePath])
    .filter((dir): dir is string => Boolean(dir));
  const inWorkspace: WorkspaceSession[] = [
    ...findClaudeSessionsInWorkDirs(workDirs).map((session) => ({
      agentTool: 'claude_code' as const,
      ...session,
    })),
    ...findCodexSessionsInWorkDirs(workDirs, codexIndex).map((session) => ({
      agentTool: 'codex' as const,
      ...session,
    })),
  ];

  const byKey = new Map<string, SessionSlotBinding>();
  for (const binding of [...local, ...workspaceBindings(options.slots, inWorkspace)]) {
    const normalized = normalizeCodexBinding(binding, codexIndex);
    byKey.set(sessionBindingKey(normalized), normalized);
  }
  const bindings = [...byKey.values()].sort((a, b) => a.at.localeCompare(b.at));

  const sessions: Record<AgentTool, Set<string>> = {
    claude_code: new Set(),
    codex: new Set(),
    cursor: new Set(),
  };
  for (const binding of [...bindings, ...(options.remoteBindings ?? [])]) {
    const ref =
      binding.agentTool === 'codex' ? codexSessionRef(binding.sessionId, codexIndex) : binding;
    sessions[binding.agentTool].add(ref.sessionId);
  }

  const observations = [
    ...[...sessions.claude_code].flatMap((id) => harvestClaudeSessionObservations(id)),
    ...harvestCodexSessionObservations(sessions.codex, codexIndex),
  ];
  // Cursor keeps no offline record; its usage only arrives live (otel-hook).
  return { bindings, observations };
}

/** Parse Mission Control's `GET /session-bindings` body leniently. */
export function parseRemoteSessionBindings(body: unknown): SessionSlotBinding[] {
  const rows = (body as { bindings?: unknown } | null)?.bindings;
  if (!Array.isArray(rows)) return [];
  const out: SessionSlotBinding[] = [];
  for (const row of rows) {
    const parsed = SessionSlotBindingSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
