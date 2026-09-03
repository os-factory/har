import type { AgentSessionUsage, WorkAttempt } from '@prisma/client';
import type { WorkUnitRelatedLink } from '@har/schemas';
import { prisma } from '@/lib/db';
import { buildTimelineRows, type TimelineRow } from '@/lib/slot-timeline';
import { attemptIdFromOccupancyKey } from '@/server/occupancy';
import {
  commitBindingsFor,
  firstPrompts,
  runInput,
  sessionInputs,
  snapshotInput,
  streamOnlySessions,
} from '@/server/slot-timeline';
import { listTrajectoryStreams } from '@/server/trajectory-ledger';
import { getValidationStages, type ValidationStagesSummary } from '@/server/validation-stages';

/**
 * The record of one occupancy — everything an agent did in one worktree session (#348).
 *
 * This is the unit History and work units are built from. It is immutable once the
 * occupancy ends, unlike a slot page, which always shows the slot's *current* occupant.
 * Only `live` says whether a slot is still on this occupancy right now.
 */
export interface AttemptRecord {
  occupancyKey: string;
  attempt: {
    attemptId: string | null;
    agentId: number | null;
    branch: string | null;
    baseCommit: string | null;
    worktreePath: string | null;
    /** ISO */
    startedAt: string | null;
    /** A slot is currently on this occupancy — the only case where a slot link is valid. */
    live: boolean;
  };
  workUnit: {
    id: string;
    workUnitId: string;
    title: string | null;
    source: string | null;
    sourceUrl: string | null;
    relatedLinks: WorkUnitRelatedLink[];
    decision: string | null;
  } | null;
  timeline: TimelineRow[];
  verification: SerializedValidationStages | null;
}

/** `ValidationStagesSummary` with ISO strings, so it survives the JSON API. */
export interface SerializedValidationStages {
  stages: Array<
    Omit<ValidationStagesSummary['stages'][number], 'lastRunAt'> & { lastRunAt: string | null }
  >;
  latestRun: (Omit<NonNullable<ValidationStagesSummary['latestRun']>, 'startedAt'> & { startedAt: string }) | null;
  verifyRunCount: number;
}

export function serializeValidationStages(summary: ValidationStagesSummary | null): SerializedValidationStages | null {
  if (!summary) return null;
  return {
    stages: summary.stages.map((stage) => ({ ...stage, lastRunAt: stage.lastRunAt?.toISOString() ?? null })),
    latestRun: summary.latestRun ? { ...summary.latestRun, startedAt: summary.latestRun.startedAt.toISOString() } : null,
    verifyRunCount: summary.verifyRunCount,
  };
}

function relatedLinks(value: unknown): WorkUnitRelatedLink[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const { source, url, label } = item as { source?: unknown; url?: unknown; label?: unknown };
    if (typeof source !== 'string' || typeof url !== 'string') return [];
    return [{ source, url, ...(typeof label === 'string' ? { label } : {}) }];
  });
}

/**
 * Rows produced before keys were stamped (#348) are recovered by the window the
 * attempt owned its work dir: from the attempt start until the next attempt that
 * reused the same work dir on the same slot.
 */
async function legacyWindow(repositoryId: string, attempt: WorkAttempt) {
  if (!attempt.workDir) return null;
  const next = await prisma.workAttempt.findFirst({
    where: {
      repositoryId,
      agentId: attempt.agentId,
      workDir: attempt.workDir,
      sourceCreatedAt: { gt: attempt.sourceCreatedAt },
    },
    orderBy: { sourceCreatedAt: 'asc' },
    select: { sourceCreatedAt: true },
  });
  return {
    agentId: attempt.agentId,
    workDir: attempt.workDir,
    from: attempt.sourceCreatedAt,
    to: next?.sourceCreatedAt ?? null,
  };
}

type Window = NonNullable<Awaited<ReturnType<typeof legacyWindow>>>;

function inWindow(window: Window | null, row: { agentId: number | null; workDir: string | null; at: Date }) {
  if (!window) return false;
  if (row.agentId !== window.agentId || row.workDir !== window.workDir) return false;
  if (row.at < window.from) return false;
  if (window.to && row.at >= window.to) return false;
  return true;
}

export async function getAttemptRecord(repositoryId: string, occupancyKey: string): Promise<AttemptRecord | null> {
  const attemptId = attemptIdFromOccupancyKey(occupancyKey);
  const [attempt, slot] = await Promise.all([
    attemptId
      ? prisma.workAttempt.findUnique({
          where: { repositoryId_attemptId: { repositoryId, attemptId } },
          include: { workUnit: true, validationBindings: { select: { validationId: true } } },
        })
      : null,
    prisma.agentSlot.findFirst({ where: { repositoryId, occupancyKey } }),
  ]);
  if (!attempt && !slot) return null;

  const agentId = attempt?.agentId ?? slot?.slotId ?? null;
  const window = attempt ? await legacyWindow(repositoryId, attempt) : null;
  const boundValidationIds = attempt?.validationBindings.map((row) => row.validationId) ?? [];

  const [runs, snapshots, usageRows, streams] = await Promise.all([
    prisma.run.findMany({
      where: {
        repositoryId,
        OR: [
          { occupancyKey },
          ...(attemptId ? [{ attemptId }] : []),
          ...(window ? [{ occupancyKey: null, agentId: window.agentId, workDir: window.workDir }] : []),
        ],
      },
      orderBy: { startedAt: 'desc' },
      take: 300,
    }),
    prisma.changeBatch.findMany({
      where: {
        repositoryId,
        OR: [
          { occupancyKey },
          ...(boundValidationIds.length ? [{ validationId: { in: boundValidationIds } }] : []),
          ...(window ? [{ occupancyKey: null, agentId: window.agentId, workDir: window.workDir }] : []),
        ],
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    }),
    prisma.agentSessionUsage.findMany({
      where: {
        repositoryId,
        OR: [
          { occupancyKey },
          ...(attemptId ? [{ attemptId }] : []),
          ...(window ? [{ occupancyKey: null, agentId: window.agentId, workDir: window.workDir }] : []),
        ],
      },
      orderBy: { lastSeenAt: 'desc' },
    }),
    agentId != null ? listTrajectoryStreams(repositoryId, agentId, occupancyKey) : Promise.resolve([]),
  ]);

  const keptRuns = runs.filter(
    (run) => run.occupancyKey === occupancyKey || (attemptId && run.attemptId === attemptId) || inWindow(window, { agentId: run.agentId, workDir: run.workDir, at: run.startedAt }),
  );
  const keptSnapshots = snapshots.filter(
    (batch) =>
      batch.occupancyKey === occupancyKey ||
      boundValidationIds.includes(batch.validationId) ||
      inWindow(window, { agentId: batch.agentId, workDir: batch.workDir, at: batch.createdAt }),
  );
  const usage: Array<AgentSessionUsage & { sources: string[] }> = usageRows
    .filter(
      (row) =>
        row.occupancyKey === occupancyKey ||
        (attemptId && row.attemptId === attemptId) ||
        inWindow(window, { agentId: row.agentId, workDir: row.workDir, at: row.firstSeenAt }),
    )
    .map((row) => ({
      ...row,
      sources: Array.isArray(row.sources) ? row.sources.filter((s): s is string => typeof s === 'string') : [],
    }));
  const streamOnly = agentId != null ? streamOnlySessions(usage, streams, agentId) : [];

  const [prompts, commits, verification] = await Promise.all([
    firstPrompts(repositoryId, [...usage, ...streamOnly]),
    commitBindingsFor(repositoryId, keptSnapshots),
    keptRuns.length
      ? getValidationStages(repositoryId, { runIds: keptRuns.map((run) => run.runId) })
      : Promise.resolve(null),
  ]);

  const startedAt = attempt?.sourceCreatedAt ?? slot?.sessionCreatedAt ?? null;
  const branch = attempt?.branch ?? slot?.branch ?? null;
  const occupancy = startedAt
    ? [{
        id: occupancyKey,
        agentId,
        title: agentId != null ? `Attempt started in slot ${agentId}` : 'Attempt started',
        at: startedAt,
        branch,
        baseCommit: attempt?.baseCommit ?? slot?.baseCommit ?? null,
        worktreePath: attempt?.worktreePath ?? attempt?.workDir ?? slot?.worktreePath ?? slot?.workDir ?? null,
        attemptId,
      }]
    : [];

  const unit = attempt?.workUnit ?? null;
  const outcome = (unit?.outcome ?? null) as { decision?: string } | null;

  return {
    occupancyKey,
    attempt: {
      attemptId,
      agentId,
      branch,
      baseCommit: attempt?.baseCommit ?? slot?.baseCommit ?? null,
      worktreePath: attempt?.worktreePath ?? attempt?.workDir ?? slot?.worktreePath ?? slot?.workDir ?? null,
      startedAt: startedAt?.toISOString() ?? null,
      live: Boolean(slot?.active && slot.occupancyKey === occupancyKey),
    },
    workUnit: unit
      ? {
          id: unit.id,
          workUnitId: unit.workUnitId,
          title: unit.title,
          source: unit.source,
          sourceUrl: unit.sourceUrl,
          relatedLinks: relatedLinks(unit.relatedLinks),
          decision: outcome?.decision ?? null,
        }
      : null,
    timeline: buildTimelineRows({
      occupancies: occupancy,
      sessions: [
        ...sessionInputs(usage, prompts),
        ...streamOnly.map((session) => ({
          ...session,
          firstPrompt: prompts.get(`${session.sessionKey}::${session.agentTool}`) ?? null,
        })),
      ],
      runs: keptRuns.map(runInput),
      snapshots: keptSnapshots.map(snapshotInput),
      commits,
    }),
    verification: serializeValidationStages(verification),
  };
}
