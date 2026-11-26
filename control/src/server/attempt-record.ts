import type { Attempt } from '@prisma/client';
import type { WorkUnitRelatedLink } from '@har/schemas';
import { prisma } from '@/lib/db';
import { type FactoryProof } from '@/lib/factory-proof';
import { changeBatchView, VERIFIED_RUN } from '@/server/change-batches';
import { factoryProofsOf } from '@/server/factory-runs';
import { attachProofs, buildTimelineRows, type TimelineRow } from '@/lib/slot-timeline';
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
import { listSessionUsageForRepo } from '@/server/usage';
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
  /** Registered repository path — the `--repo` for copy-able commands (#340). */
  repositoryPath: string | null;
  /** Git remote, so Handoff and timeline rows can link a commit on the code host (#340). */
  gitRemote: string | null;
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
  /** Factory Commits proofs received for this attempt's verifications, newest first. */
  proofs: FactoryProof[];
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
export async function legacyWindow(repositoryId: string, attempt: Attempt) {
  if (!attempt.workDir || attempt.agentId == null) return null;
  const next = await prisma.attempt.findFirst({
    where: {
      repositoryId,
      agentId: attempt.agentId,
      workDir: attempt.workDir,
      startedAt: { gt: attempt.startedAt },
    },
    orderBy: { startedAt: 'asc' },
    select: { startedAt: true },
  });
  return {
    agentId: attempt.agentId,
    workDir: attempt.workDir,
    from: attempt.startedAt,
    to: next?.startedAt ?? null,
  };
}

export type LegacyWindow = NonNullable<Awaited<ReturnType<typeof legacyWindow>>>;

export function inWindow(window: LegacyWindow | null, row: { agentId: number | null; workDir: string | null; at: Date }) {
  if (!window) return false;
  if (row.agentId !== window.agentId || row.workDir !== window.workDir) return false;
  if (row.at < window.from) return false;
  if (window.to && row.at >= window.to) return false;
  return true;
}

/**
 * The verification traces of one attempt: those stamped with its attempt id, and
 * those naming a validation its snapshots recorded (a trace spooled before the
 * attempt was bound still joins by validation id).
 */
export async function proofsForAttempt(
  repositoryId: string,
  attemptId: string | null,
  snapshots: Array<{ validationId: string; runId: string | null }>,
  verifyRunIds: string[],
): Promise<FactoryProof[]> {
  const validationIds = [...new Set(snapshots.map((snapshot) => snapshot.validationId))];
  const or = [
    ...(attemptId ? [{ attemptId }] : []),
    ...(validationIds.length ? [{ factoryRunId: { in: validationIds } }] : []),
    ...(verifyRunIds.length ? [{ factoryRunId: { in: verifyRunIds } }] : []),
  ];
  if (or.length === 0) return [];
  const runs = await prisma.factoryRun.findMany({
    where: { repositoryId, traceId: { not: null }, OR: or },
    orderBy: [{ startedAt: 'desc' }, { id: 'asc' }],
    take: 50,
  });
  const byValidation = new Map(snapshots.map((snapshot) => [snapshot.validationId, snapshot.runId]));
  return factoryProofsOf(runs, byValidation, new Set(verifyRunIds));
}

export async function getAttemptRecord(repositoryId: string, occupancyKey: string): Promise<AttemptRecord | null> {
  const attemptId = attemptIdFromOccupancyKey(occupancyKey);
  const [attempt, slot, repository] = await Promise.all([
    attemptId
      ? prisma.attempt.findUnique({ where: { attemptId } })
      : null,
    prisma.agentSlot.findFirst({ where: { repositoryId, occupancyKey } }),
    prisma.repository.findUnique({ where: { id: repositoryId }, select: { path: true, gitRemote: true } }),
  ]);
  if (!attempt && !slot) return null;
  const [unit, boundRuns] = attempt
    ? await Promise.all([
        attempt.workUnitId
          ? prisma.workUnit.findUnique({
              where: { repositoryKey_workUnitId: { repositoryKey: attempt.repositoryKey, workUnitId: attempt.workUnitId } },
            })
          : null,
        prisma.factoryRun.findMany({ where: { attemptId: attempt.attemptId }, select: { factoryRunId: true } }),
      ])
    : [null, []];

  const agentId = attempt?.agentId ?? slot?.slotId ?? null;
  const window: LegacyWindow | null = attempt ? await legacyWindow(repositoryId, attempt) : null;
  const boundValidationIds = boundRuns.map((row) => row.factoryRunId);

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
    prisma.factoryRun.findMany({
      where: {
        repositoryId,
        ...VERIFIED_RUN,
        OR: [
          { occupancyKey },
          ...(boundValidationIds.length ? [{ factoryRunId: { in: boundValidationIds } }] : []),
          ...(window ? [{ occupancyKey: null, agentId: window.agentId, workDir: window.workDir }] : []),
        ],
      },
      orderBy: { startedAt: 'desc' },
      take: 200,
    }).then((runs) => runs.map(changeBatchView)),
    listSessionUsageForRepo(repositoryId),
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
  // ADR 0003: derived usage rows carry the occupancy of the binding they were
  // attributed through; legacy rows still join by stamp or legacy window.
  const usage = usageRows.filter(
    (row) =>
      row.occupancyKey === occupancyKey ||
      (attemptId && row.attemptId === attemptId) ||
      (row.origin === 'legacy' && row.occupancyKey == null && inWindow(window, { agentId: row.agentId, workDir: row.workDir, at: row.firstSeenAt })),
  );
  const streamOnly = agentId != null ? streamOnlySessions(usage, streams, agentId) : [];

  const [prompts, commits, verification, proofs] = await Promise.all([
    firstPrompts(repositoryId, [...usage, ...streamOnly]),
    commitBindingsFor(repositoryId, keptSnapshots),
    keptRuns.length
      ? getValidationStages(repositoryId, { runIds: keptRuns.map((run) => run.runId) })
      : Promise.resolve(null),
    proofsForAttempt(
      repositoryId,
      attemptId,
      keptSnapshots,
      keptRuns.filter((run) => run.stageId === 'verify').map((run) => run.runId),
    ),
  ]);

  const startedAt = attempt?.startedAt ?? slot?.sessionCreatedAt ?? null;
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

  const outcome = (unit?.outcome ?? null) as { decision?: string } | null;

  return {
    occupancyKey,
    repositoryPath: repository?.path ?? null,
    gitRemote: repository?.gitRemote ?? null,
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
    timeline: attachProofs(buildTimelineRows({
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
    }), proofs),
    verification: serializeValidationStages(verification),
    proofs,
  };
}
