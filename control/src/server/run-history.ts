import type { FactoryRun, Prisma, Run, StageResult } from '@prisma/client';
import { prisma } from '@/lib/db';

/**
 * The verify runs Mission Control shows (slot "last verify", History, the
 * verification trend, stage badges, factory lines, the attempt record), read
 * from both data models:
 *
 * - `Run`: the per-command history a 1.x CLI synced (`har control sync`). The
 *   2.0 CLI no longer sends it (ADR 0005 section 7), but a migrated database
 *   keeps its rows and they still display.
 * - `FactoryRun` + `StageResult`: what every 2.0 receiver gets (v2 records and
 *   verification spans). Each factory run reads as one `verify` run: id = the
 *   factory run id, status from the verdict (or the pipeline result of a quick
 *   verify), stages from its stage results. A factory run converted from 1.x
 *   (`runId` set) is already a `Run` and is not repeated.
 *
 * Only verify runs exist in v2: launch, teardown and other commands of a 2.0
 * CLI have no record, and a factory line's gate stages are read per stage from
 * the stage results (`latestStageRuns`).
 */
export interface RunFilter {
  repositoryIds: string[];
  /** Command stage ids (`verify`, `launch`, ...). v2 contributes `verify` runs only. */
  stageIds?: string[];
  agentId?: number;
  workDir?: string;
  since?: Date;
  /** Run ids; a v2 run's id is its factory run id. */
  runIds?: string[];
  workUnitId?: string;
  /** Any of these places (an occupancy, an attempt, a slot number and work dir). */
  anyOf?: Array<{ occupancyKey?: string | null; attemptId?: string; agentId?: number | null; workDir?: string | null }>;
  take: number;
  order?: 'asc' | 'desc';
}

type FactoryRunWithStages = FactoryRun & { stages: StageResult[] };

const PASSED = new Set(['pass', 'passed', 'success']);

/** A v2 verdict or pipeline result as a 1.x run status. */
export function runStatusOf(run: Pick<FactoryRun, 'verdict' | 'status'>): string {
  const value = (run.verdict ?? run.status ?? '').toLowerCase();
  if (PASSED.has(value)) return 'pass';
  if (!value) return 'unknown';
  return 'fail';
}

/** A factory run as the `Run` row the 1.x readers expect. */
export function runOfFactoryRun(run: FactoryRunWithStages): Run {
  const order = Array.isArray(run.stageIds) ? (run.stageIds as unknown[]).map(String) : [];
  const rank = (stageId: string) => {
    const index = order.indexOf(stageId);
    return index === -1 ? order.length : index;
  };
  const stages = [...run.stages]
    .sort((a, b) => rank(a.stageId) - rank(b.stageId) || a.stageId.localeCompare(b.stageId))
    .map((stage) => ({
      name: stage.stageId,
      pass: stage.status === 'passed' || stage.status === 'skipped',
      ...(stage.durationMs != null ? { ms: stage.durationMs } : {}),
    }));
  const durationMs = run.finishedAt ? Math.max(0, run.finishedAt.getTime() - run.startedAt.getTime()) : null;
  return {
    id: `factory-run:${run.id}`,
    runId: run.factoryRunId,
    repositoryId: run.repositoryId ?? '',
    stageId: 'verify',
    kind: 'verify',
    agentId: run.agentId,
    status: runStatusOf(run),
    trigger: 'cli',
    durationMs,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    workDir: run.workDir,
    workUnitId: run.workUnitId,
    attemptId: run.attemptId,
    occupancyKey: run.occupancyKey,
    result: (stages.length > 0
      ? { data: { verification: { stages, full: run.full } } }
      : null) as Prisma.JsonValue,
    createdAt: run.createdAt,
  };
}

function placeWhere(place: NonNullable<RunFilter['anyOf']>[number]) {
  const where: Record<string, unknown> = {};
  if (place.occupancyKey !== undefined) where.occupancyKey = place.occupancyKey;
  if (place.attemptId !== undefined) where.attemptId = place.attemptId;
  if (place.agentId !== undefined) where.agentId = place.agentId;
  if (place.workDir !== undefined) where.workDir = place.workDir;
  return where;
}

function commonWhere(filter: RunFilter, runIdKey: 'runId' | 'factoryRunId') {
  return {
    repositoryId: { in: filter.repositoryIds },
    ...(filter.agentId != null ? { agentId: filter.agentId } : {}),
    ...(filter.workDir ? { workDir: filter.workDir } : {}),
    ...(filter.since ? { startedAt: { gte: filter.since } } : {}),
    ...(filter.runIds ? { [runIdKey]: { in: filter.runIds } } : {}),
    ...(filter.workUnitId ? { workUnitId: filter.workUnitId } : {}),
    ...(filter.anyOf ? { OR: filter.anyOf.map(placeWhere) } : {}),
  };
}

/** Runs of both models, newest first (or oldest first), at most `take`. */
export async function listRuns(filter: RunFilter): Promise<Run[]> {
  if (filter.repositoryIds.length === 0 || filter.anyOf?.length === 0) return [];
  const direction = filter.order ?? 'desc';
  const wantsVerify = !filter.stageIds || filter.stageIds.includes('verify');
  const [legacy, factoryRuns] = await Promise.all([
    prisma.run.findMany({
      where: {
        ...commonWhere(filter, 'runId'),
        ...(filter.stageIds ? { stageId: { in: filter.stageIds } } : {}),
      } as Prisma.RunWhereInput,
      orderBy: { startedAt: direction },
      take: filter.take,
    }),
    wantsVerify
      ? prisma.factoryRun.findMany({
          where: { ...commonWhere(filter, 'factoryRunId'), runId: null } as Prisma.FactoryRunWhereInput,
          orderBy: { startedAt: direction },
          take: filter.take,
        }).then((runs) => runs.filter((run) => run.runId == null))
      : Promise.resolve([] as FactoryRun[]),
  ]);
  const stages = factoryRuns.length
    ? await prisma.stageResult.findMany({ where: { factoryRunId: { in: factoryRuns.map((run) => run.factoryRunId) } } })
    : [];
  const byRun = new Map<string, StageResult[]>();
  for (const stage of stages) byRun.set(stage.factoryRunId, [...(byRun.get(stage.factoryRunId) ?? []), stage]);
  const merged = [
    ...legacy,
    ...factoryRuns.map((run) => runOfFactoryRun({ ...run, stages: byRun.get(run.factoryRunId) ?? [] })),
  ];
  const sign = direction === 'desc' ? -1 : 1;
  merged.sort((a, b) => sign * (a.startedAt.getTime() - b.startedAt.getTime()));
  return merged.slice(0, filter.take);
}

export interface StageRun {
  status: string;
  startedAt: Date;
  durationMs: number | null;
  agentId: number | null;
}

/**
 * Latest result of each stage id in a repository: a 1.x `Run` of that stage
 * (a factory line gate stage, `har line gate`), or the stage's result in a v2
 * factory run, whichever is newer. Status `pass` or `fail`.
 */
export async function latestStageRuns(
  repositoryId: string,
  stageIds: string[],
): Promise<Map<string, StageRun>> {
  const out = new Map<string, StageRun>();
  if (stageIds.length === 0) return out;
  const [runs, results] = await Promise.all([
    prisma.run.findMany({
      where: { repositoryId, stageId: { in: stageIds } },
      orderBy: { startedAt: 'desc' },
      select: { stageId: true, status: true, startedAt: true, durationMs: true, agentId: true },
    }),
    prisma.stageResult.findMany({
      where: { stageId: { in: stageIds } },
      select: { stageId: true, status: true, startTime: true, factoryRunId: true, durationMs: true },
    }),
  ]);
  const runsOfRepo = results.length
    ? await prisma.factoryRun.findMany({
        where: { repositoryId, factoryRunId: { in: [...new Set(results.map((row) => row.factoryRunId))] } },
        select: { factoryRunId: true, startedAt: true, agentId: true },
      })
    : [];
  const ofRun = new Map(runsOfRepo.map((run) => [run.factoryRunId, run]));
  const offer = (stageId: string, run: StageRun) => {
    const seen = out.get(stageId);
    if (!seen || run.startedAt > seen.startedAt) out.set(stageId, run);
  };
  for (const run of runs) offer(run.stageId, run);
  for (const result of results) {
    const run = ofRun.get(result.factoryRunId);
    if (!run) continue;
    offer(result.stageId, {
      status: result.status === 'passed' || result.status === 'skipped' ? 'pass' : 'fail',
      startedAt: result.startTime ?? run.startedAt,
      durationMs: result.durationMs,
      agentId: run.agentId,
    });
  }
  return out;
}
