import type { AgentSessionUsage, AgentSlot, ChangeBatch, Run, ValidationCommitBinding } from '@prisma/client';
import { prisma } from '@/lib/db';
import {
  buildTimelineRows,
  type TimelineChangedFile,
  type TimelineCommitInput,
  type TimelineRow,
  type TimelineRunInput,
  type TimelineSessionInput,
  type TimelineSnapshotInput,
  type TimelineStageChip,
} from '@/lib/slot-timeline';
import { modelsFromBreakdown } from '@/lib/usage-models';
import { listTrajectoryStreams } from '@/server/trajectory-ledger';
import { listSessionUsageForSlot } from '@/server/usage';
import { extractVerification } from '@/server/validation-stages';

/**
 * A trajectory can exist before (or without) a usage row — e.g. OTEL prompts arrive
 * before the first token count is harvested. Surface it as a session row anyway.
 */
export function streamOnlySessions(
  usage: Array<Pick<AgentSessionUsage, 'sessionKey' | 'agentTool'>>,
  streams: Array<{ sessionKey: string; agentTool: string; latestTimestamp: string }>,
  agentId: number,
): TimelineSessionInput[] {
  const usageKeys = new Set(usage.map((row) => `${row.sessionKey}::${row.agentTool}`));
  return streams
    .filter((stream) => !usageKeys.has(`${stream.sessionKey}::${stream.agentTool}`))
    .map((stream) => ({
      sessionKey: stream.sessionKey,
      agentTool: stream.agentTool,
      agentId,
      models: [],
      tokensTotal: 0,
      costUsd: null,
      sources: ['trajectory'],
      firstSeenAt: new Date(stream.latestTimestamp),
      lastSeenAt: new Date(stream.latestTimestamp),
      firstPrompt: null,
    }));
}


const RUN_LIMIT = 300;
const SNAPSHOT_LIMIT = 200;

function stageChips(result: unknown): TimelineStageChip[] {
  const verification = extractVerification(result);
  if (!verification) return [];
  return verification.stages.map((stage) => ({
    name: stage.name,
    pass: Boolean(stage.pass),
    ms: typeof stage.ms === 'number' ? stage.ms : null,
  }));
}

function changedFiles(value: unknown): TimelineChangedFile[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const { status, path } = entry as { status?: unknown; path?: unknown };
    if (typeof path !== 'string') return [];
    return [{ status: typeof status === 'string' ? status : '', path }];
  });
}

function refs(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function runInput(run: Run): TimelineRunInput {
  return {
    runId: run.runId,
    stageId: run.stageId,
    kind: run.kind,
    status: run.status,
    trigger: run.trigger,
    durationMs: run.durationMs,
    agentId: run.agentId,
    startedAt: run.startedAt,
    stages: stageChips(run.result),
  };
}

export function snapshotInput(batch: ChangeBatch): TimelineSnapshotInput {
  return {
    validationId: batch.validationId,
    treeHash: batch.treeHash,
    branch: batch.branch,
    agentId: batch.agentId,
    status: batch.status,
    full: batch.full,
    runId: batch.runId,
    changedFiles: changedFiles(batch.changedFiles),
    commitSha: batch.commitSha,
    committedAt: batch.committedAt,
    createdAt: batch.createdAt,
  };
}

function commitInput(binding: ValidationCommitBinding, snapshot: ChangeBatch | undefined): TimelineCommitInput {
  return {
    commitSha: binding.commitSha,
    treeHash: binding.treeHash,
    message: binding.message,
    refs: refs(binding.refs),
    branch: snapshot?.branch ?? null,
    agentId: snapshot?.agentId ?? null,
    at: binding.sourceCreatedAt,
  };
}

export async function firstPrompts(repositoryId: string, sessions: Array<Pick<AgentSessionUsage, 'sessionKey' | 'agentTool'>>) {
  const prompts = new Map<string, string>();
  await Promise.all(
    sessions.map(async (session) => {
      const event = await prisma.agentSessionEvent.findFirst({
        where: {
          repositoryId,
          sessionKey: session.sessionKey,
          agentTool: session.agentTool,
          promptText: { not: null },
        },
        orderBy: [{ timestamp: 'asc' }, { sequence: 'asc' }],
        select: { promptText: true },
      });
      if (event?.promptText) prompts.set(`${session.sessionKey}::${session.agentTool}`, event.promptText);
    }),
  );
  return prompts;
}

export function sessionInputs(
  rows: Array<AgentSessionUsage & { sources: string[] }>,
  prompts: Map<string, string>,
): TimelineSessionInput[] {
  return rows.map((row) => ({
    sessionKey: row.sessionKey,
    agentTool: row.agentTool,
    agentId: row.agentId,
    models: modelsFromBreakdown(row.modelBreakdown),
    tokensTotal: Number(row.tokensTotal),
    costUsd: row.costUsd == null ? null : Number(row.costUsd),
    costSource: row.costSource,
    sources: row.sources,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    firstPrompt: prompts.get(`${row.sessionKey}::${row.agentTool}`) ?? null,
  }));
}

export async function commitBindingsFor(repositoryId: string, snapshots: ChangeBatch[]) {
  if (snapshots.length === 0) return [] as TimelineCommitInput[];
  const byTree = new Map(snapshots.map((snapshot) => [snapshot.treeHash, snapshot]));
  const bindings = await prisma.validationCommitBinding.findMany({
    where: { repositoryId, treeHash: { in: [...byTree.keys()] } },
    orderBy: { sourceCreatedAt: 'desc' },
  });
  return bindings.map((binding) => commitInput(binding, byTree.get(binding.treeHash)));
}

/**
 * Timeline of a slot's CURRENT occupancy — live data (#316, #348). The occupancy is
 * identified by `occupancyKey` where stamped, else by `sessionCreatedAt` + `workDir`:
 * rows for this slot number from before that instant, or from another worktree, belong
 * to an earlier occupant and live in the repository History instead.
 */
export async function getSlotTimeline(repositoryId: string, slot: AgentSlot): Promise<TimelineRow[]> {
  const since = slot.sessionCreatedAt;
  const workDir = slot.workDir;
  const inCurrent = (row: { startedAt?: Date; createdAt?: Date; workDir: string | null; occupancyKey: string | null }) => {
    if (slot.occupancyKey && row.occupancyKey) return row.occupancyKey === slot.occupancyKey;
    const at = row.startedAt ?? row.createdAt;
    if (since && at && at < since) return false;
    if (workDir && row.workDir && row.workDir !== workDir) return false;
    return true;
  };

  const [runs, snapshots, usage, streams] = await Promise.all([
    prisma.run.findMany({
      where: { repositoryId, agentId: slot.slotId },
      orderBy: { startedAt: 'desc' },
      take: RUN_LIMIT,
    }),
    prisma.changeBatch.findMany({
      where: { repositoryId, agentId: slot.slotId },
      orderBy: { createdAt: 'desc' },
      take: SNAPSHOT_LIMIT,
    }),
    listSessionUsageForSlot(repositoryId, slot.slotId, slot.occupancyKey),
    listTrajectoryStreams(repositoryId, slot.slotId, slot.occupancyKey),
  ]);

  const streamOnly = streamOnlySessions(usage, streams, slot.slotId);

  const currentRuns = runs.filter(inCurrent);
  const currentSnapshots = snapshots.filter(inCurrent);

  const [prompts, currentCommits] = await Promise.all([
    firstPrompts(repositoryId, [...usage, ...streamOnly]),
    commitBindingsFor(repositoryId, currentSnapshots),
  ]);

  const occupancies = since
    ? [{
        id: slot.occupancyKey ?? `${slot.slotId}:${since.toISOString()}`,
        agentId: slot.slotId,
        title: slot.active ? `Session started in slot ${slot.slotId}` : `Last session started in slot ${slot.slotId}`,
        at: since,
        branch: slot.branch,
        baseCommit: slot.baseCommit,
        worktreePath: slot.worktreePath ?? slot.workDir,
        attemptId: slot.attemptId,
      }]
    : [];

  return buildTimelineRows({
    occupancies,
    sessions: [
      ...sessionInputs(usage, prompts),
      ...streamOnly.map((session) => ({
        ...session,
        firstPrompt: prompts.get(`${session.sessionKey}::${session.agentTool}`) ?? null,
      })),
    ],
    runs: currentRuns.map(runInput),
    snapshots: currentSnapshots.map(snapshotInput),
    commits: currentCommits,
  });
}
