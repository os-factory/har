import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { LineLedgerSchema, LineProgramSchema, type LineProgram } from '@har/schemas';
import { prisma } from '@/lib/db';

/**
 * Factory line board read model (#305).
 *
 * A line is a *program* over records Mission Control already has: stations in
 * order, slots occupying them, and a cumulative gate whose results are ordinary
 * `Run` rows. This is a **view**, not a second execution engine — nothing here
 * runs a stage, installs a bundle, or edits a tracker.
 *
 * The program itself is per-repo installed state (`.har/lines.json` +
 * `.har/lines/<id>/line.json`), the same source `har line status` reads. It is
 * deliberately not inferred from `verificationStages`: line gate stages are
 * absent from the verify plan by design, and drawing them as verify stages
 * would report a healthy pipeline as broken.
 */

export interface LineBoardStation {
  id: string;
  title: string;
  description?: string;
  index: number;
  /** Cumulative: every gate stage tagged here or at an earlier station. */
  requiredStageIds: string[];
  passedStageIds: string[];
  failedStageIds: string[];
  neverRunStageIds: string[];
  /** Required stages the harness does not have registered. */
  missingStageIds: string[];
  green: boolean;
  work?: { source: string; ids: string[]; url?: string };
}

export interface LineBoardSlot {
  slotId: number;
  branch: string | null;
  purpose: string | null;
  workUnitId: string | null;
  workDir: string | null;
}

export interface LineBoardGateRun {
  stageId: string;
  status: string;
  startedAt: string;
  durationMs: number | null;
  agentId: number | null;
}

export interface LineBoard {
  id: string;
  title: string;
  description?: string;
  source: string;
  spec: string;
  installedAt: string;
  programPath: string;
  stations: LineBoardStation[];
  currentStationId: string | null;
  nextStationId: string | null;
  optInEnv: string | null;
  /** Stages this line registered — none of them are on the verify plan. */
  registeredStageIds: string[];
  /** Registered line stages that have leaked into `verificationStages`. */
  verifyLeaks: string[];
  latestGateRuns: LineBoardGateRun[];
  slotsInFlight: LineBoardSlot[];
  declared: {
    skills: Array<{ id: string; role: string; install?: string }>;
    mcp: Array<{ name: string; why?: string; required: boolean }>;
    plugins: string[];
  };
  handoffAutonomousShip: false;
}

function readJson(file: string): unknown | null {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** `har line status`'s ratchet, as data: tagged at this station or earlier. */
function cumulativeStageIds(program: LineProgram, stationId: string): string[] {
  const order = new Map(program.stations.map((s, i) => [s.id, i]));
  const target = order.get(stationId);
  if (target === undefined) return [];
  const ids = program.gate.stages
    .filter((stage) => {
      const from = order.get(stage.fromStation);
      return from !== undefined && from <= target;
    })
    .map((stage) => stage.id);
  return [...new Set(ids)];
}

function readVerificationStages(repoPath: string): { ids: string[]; registered: Set<string> } {
  const registry = readJson(path.join(repoPath, '.har', 'stages.json')) as
    | { verificationStages?: string[]; stages?: Array<{ id: string }> }
    | null;
  return {
    ids: registry?.verificationStages ?? [],
    registered: new Set((registry?.stages ?? []).map((s) => s.id)),
  };
}

/**
 * Every factory line installed in a repository, with station progress derived
 * from synced run records. Returns [] when the repo has no line bundle — the
 * board's empty state, not an error.
 */
export async function listLineBoards(repositoryId: string): Promise<LineBoard[]> {
  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { path: true },
  });
  if (!repo) return [];

  const ledgerRaw = readJson(path.join(repo.path, '.har', 'lines.json'));
  const ledger = LineLedgerSchema.safeParse(ledgerRaw);
  if (!ledger.success || ledger.data.lines.length === 0) return [];

  const { ids: verificationStages, registered } = readVerificationStages(repo.path);

  const slots = await prisma.agentSlot.findMany({
    where: { repositoryId, active: true },
    orderBy: { slotId: 'asc' },
    select: { slotId: true, branch: true, purpose: true, workUnitId: true, workDir: true },
  });

  const boards: LineBoard[] = [];

  for (const entry of ledger.data.lines) {
    const programRaw = readJson(path.join(repo.path, entry.programPath));
    const parsed = LineProgramSchema.safeParse(programRaw);
    if (!parsed.success) continue;
    const program = parsed.data;

    const gateStageIds = [...new Set(program.gate.stages.map((s) => s.id))];

    // Latest run per gate stage — the same evidence `har line status` uses.
    const runs = gateStageIds.length
      ? await prisma.run.findMany({
          where: { repositoryId, stageId: { in: gateStageIds } },
          orderBy: { startedAt: 'desc' },
        })
      : [];
    const latestByStage = new Map<string, (typeof runs)[number]>();
    for (const run of runs) {
      if (!latestByStage.has(run.stageId)) latestByStage.set(run.stageId, run);
    }

    const stations: LineBoardStation[] = program.stations.map((station, index) => {
      const requiredStageIds = cumulativeStageIds(program, station.id);
      const missingStageIds = requiredStageIds.filter((id) => !registered.has(id));
      const passedStageIds = requiredStageIds.filter(
        (id) => latestByStage.get(id)?.status === 'pass',
      );
      const failedStageIds = requiredStageIds.filter((id) => {
        const status = latestByStage.get(id)?.status;
        return status !== undefined && status !== 'pass';
      });
      const neverRunStageIds = requiredStageIds.filter((id) => !latestByStage.has(id));
      return {
        id: station.id,
        title: station.title,
        description: station.description,
        index,
        requiredStageIds,
        passedStageIds,
        failedStageIds,
        neverRunStageIds,
        missingStageIds,
        green:
          missingStageIds.length === 0 && passedStageIds.length === requiredStageIds.length,
        work: station.work
          ? { source: station.work.source, ids: station.work.ids, url: station.work.url }
          : undefined,
      };
    });

    let currentStationId: string | null = null;
    for (const station of stations) {
      if (station.green) currentStationId = station.id;
      else break;
    }

    boards.push({
      id: entry.id,
      title: program.title,
      description: program.description,
      source: entry.source,
      spec: entry.spec,
      installedAt: entry.installedAt,
      programPath: entry.programPath,
      stations,
      currentStationId,
      nextStationId: stations.find((s) => !s.green)?.id ?? null,
      optInEnv: program.gate.optInEnv,
      registeredStageIds: entry.stageIds,
      verifyLeaks: entry.stageIds.filter((id) => verificationStages.includes(id)),
      latestGateRuns: gateStageIds.flatMap((stageId) => {
        const run = latestByStage.get(stageId);
        return run
          ? [
              {
                stageId,
                status: run.status,
                startedAt: run.startedAt.toISOString(),
                durationMs: run.durationMs,
                agentId: run.agentId,
              },
            ]
          : [];
      }),
      slotsInFlight: slots,
      declared: {
        skills: program.skills.map((s) => ({ id: s.id, role: s.role, install: s.install })),
        mcp: program.mcp.map((m) => ({ name: m.name, why: m.why, required: m.required })),
        plugins: program.plugins,
      },
      handoffAutonomousShip: false,
    });
  }

  return boards;
}

/** Whether the repository has a `.har/` harness at all (drives the empty state). */
export async function repositoryHasHarness(repositoryId: string): Promise<boolean> {
  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    select: { path: true },
  });
  return Boolean(repo && existsSync(path.join(repo.path, '.har')));
}
