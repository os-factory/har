import type { AgentSessionUsage, AgentSlot, ChangeBatch, Run, ValidationCommitBinding, WorkAttempt } from '@prisma/client';
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

export interface SlotTimeline {
  /** Events of the slot's current occupancy (or the last one, when idle). */
  current: TimelineRow[];
  /** Events recorded under this slot number by earlier occupants. Never deleted, collapsed by default. */
  previous: TimelineRow[];
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

async function firstPrompts(repositoryId: string, sessions: Array<Pick<AgentSessionUsage, 'sessionKey' | 'agentTool'>>) {
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

function sessionInputs(
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
    sources: row.sources,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    firstPrompt: prompts.get(`${row.sessionKey}::${row.agentTool}`) ?? null,
  }));
}

async function commitBindingsFor(repositoryId: string, snapshots: ChangeBatch[]) {
  if (snapshots.length === 0) return [] as TimelineCommitInput[];
  const byTree = new Map(snapshots.map((snapshot) => [snapshot.treeHash, snapshot]));
  const bindings = await prisma.validationCommitBinding.findMany({
    where: { repositoryId, treeHash: { in: [...byTree.keys()] } },
    orderBy: { sourceCreatedAt: 'desc' },
  });
  return bindings.map((binding) => commitInput(binding, byTree.get(binding.treeHash)));
}

/**
 * Timeline of one slot. The current occupancy is identified by the slot's
 * `sessionCreatedAt` + `workDir` (#316): runs and snapshots recorded for this slot
 * number before that instant, or from another worktree, belong to a previous occupant.
 */
export async function getSlotTimeline(repositoryId: string, slot: AgentSlot): Promise<SlotTimeline> {
  const since = slot.sessionCreatedAt;
  const workDir = slot.workDir;
  const inCurrent = (row: { startedAt?: Date; createdAt?: Date; workDir: string | null }) => {
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

  // A trajectory can exist before (or without) a usage row — e.g. OTEL prompts arrive
  // before the first token count is harvested. Surface it as a session row anyway.
  const usageKeys = new Set(usage.map((row) => `${row.sessionKey}::${row.agentTool}`));
  const streamOnly: TimelineSessionInput[] = streams
    .filter((stream) => !usageKeys.has(`${stream.sessionKey}::${stream.agentTool}`))
    .map((stream) => ({
      sessionKey: stream.sessionKey,
      agentTool: stream.agentTool,
      agentId: slot.slotId,
      models: [],
      tokensTotal: 0,
      costUsd: null,
      sources: ['trajectory'],
      firstSeenAt: new Date(stream.latestTimestamp),
      lastSeenAt: new Date(stream.latestTimestamp),
      firstPrompt: null,
    }));

  const currentRuns = runs.filter(inCurrent);
  const previousRuns = runs.filter((run) => !inCurrent(run));
  const currentSnapshots = snapshots.filter(inCurrent);
  const previousSnapshots = snapshots.filter((snapshot) => !inCurrent(snapshot));

  const [prompts, currentCommits, previousCommits] = await Promise.all([
    firstPrompts(repositoryId, [...usage, ...streamOnly]),
    commitBindingsFor(repositoryId, currentSnapshots),
    commitBindingsFor(repositoryId, previousSnapshots),
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

  return {
    current: buildTimelineRows({
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
    }),
    previous: buildTimelineRows({
      runs: previousRuns.map(runInput),
      snapshots: previousSnapshots.map(snapshotInput),
      commits: previousCommits,
    }),
  };
}

/** Timeline of a work unit across every attempt and slot that worked it. */
export async function getWorkUnitTimeline(input: {
  repositoryId: string;
  workUnitId: string;
  attempts: WorkAttempt[];
  runs: Run[];
  validations: ChangeBatch[];
}): Promise<TimelineRow[]> {
  const usageRows = await prisma.agentSessionUsage.findMany({
    where: { repositoryId: input.repositoryId, workUnitId: input.workUnitId },
    orderBy: { firstSeenAt: 'desc' },
  });
  const usage = usageRows.map((row) => ({
    ...row,
    sources: Array.isArray(row.sources) ? row.sources.filter((s): s is string => typeof s === 'string') : [],
  }));
  const [prompts, commits] = await Promise.all([
    firstPrompts(input.repositoryId, usage),
    commitBindingsFor(input.repositoryId, input.validations),
  ]);

  return buildTimelineRows({
    occupancies: input.attempts.map((attempt) => ({
      id: attempt.attemptId,
      agentId: attempt.agentId,
      title: `Attempt started in slot ${attempt.agentId}`,
      at: attempt.sourceCreatedAt,
      branch: attempt.branch,
      baseCommit: attempt.baseCommit,
      worktreePath: attempt.worktreePath ?? attempt.workDir,
      attemptId: attempt.attemptId,
    })),
    sessions: sessionInputs(usage, prompts),
    runs: input.runs.map(runInput),
    snapshots: input.validations.map(snapshotInput),
    commits,
  });
}
