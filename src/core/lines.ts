import * as path from 'path';
import { applyLine, readInstalledLineProgram, type ApplyLineOptions, type ApplyLineResult } from '../harness/lines';
import { createLine, type CreateLineOptions, type CreateLineResult } from '../harness/line-create';
import { readLineLedger } from '../harness/line-ledger';
import { listLocalLineIds } from '../harness/line-resolve';
import { readStageRegistry } from '../harness/stages';
import type { LineGateStage, LineProgram, LineStation } from '../harness/schema';
import { listSlotRegistryEntries } from './slot-registry';
import { listRuns } from './runs';
import { runStage } from './run-service';
import type { StageResult } from '../harness/schema';

/**
 * Factory-line orchestration (#304).
 *
 * Core owns the logic; `cli/commands/line.ts` and `mcp/server.ts` are thin
 * adapters over these functions. Gate execution goes through the existing
 * `RunService.runStage` — there is deliberately no second stage runner.
 */

export interface LineStationStatus {
  id: string;
  title: string;
  index: number;
  /** Cumulative: every gate stage tagged at this station or an earlier one. */
  requiredStageIds: string[];
  /** Gate stages that have a passing run record. */
  passedStageIds: string[];
  /** Required stages with no run record at all. */
  neverRunStageIds: string[];
  /** Required stages that are not registered in .har/stages.json. */
  missingStageIds: string[];
  /** All required stages green. */
  green: boolean;
  work?: LineStation['work'];
}

export interface LineSlotInFlight {
  agentId: number;
  branch?: string;
  workUnitId?: string;
  workDir: string;
}

export interface LineStatus {
  lineId: string;
  title: string;
  programPath: string;
  installed: boolean;
  source?: string;
  stations: LineStationStatus[];
  /** Last station whose required stages are all green. */
  currentStationId?: string;
  /** First station that is not green — where the line is working now. */
  nextStationId?: string;
  optInEnv: string | null;
  /** Registered line stages that are (correctly) absent from verificationStages. */
  registeredStageIds: string[];
  /** Set when a line stage has leaked onto the verify plan. */
  verifyLeaks: string[];
  slotsInFlight: LineSlotInFlight[];
  handoffAutonomousShip: false;
  warnings: string[];
}

/** Ids of every line installed in this repo (ledger first, then on-disk). */
export function listInstalledLineIds(repoPath: string): string[] {
  const ledger = readLineLedger(repoPath);
  const fromLedger = ledger?.lines.map((l) => l.id) ?? [];
  const onDisk = listLocalLineIds(repoPath).filter(
    (id) => readInstalledLineProgram(repoPath, id) !== null,
  );
  return [...new Set([...fromLedger, ...onDisk])].sort();
}

/**
 * The ratchet, as data: a stage tagged `fromStation: X` is required at X and
 * at every later station. Order comes from `stations[]`, so growing the line
 * can never drop an earlier station's stages.
 */
export function cumulativeGateStages(program: LineProgram, stationId: string): LineGateStage[] {
  const stationIndex = program.stations.findIndex((s) => s.id === stationId);
  if (stationIndex < 0) {
    throw new Error(
      `Unknown station "${stationId}". Stations: ${program.stations.map((s) => s.id).join(', ')}`,
    );
  }
  const indexOf = new Map(program.stations.map((s, i) => [s.id, i]));
  return program.gate.stages.filter((stage) => {
    const from = indexOf.get(stage.fromStation);
    return from !== undefined && from <= stationIndex;
  });
}

function latestRunStatusByStage(repoPath: string, stageIds: string[]): Map<string, string> {
  const statuses = new Map<string, string>();
  for (const stageId of stageIds) {
    const [latest] = listRuns(repoPath, { stageId, limit: 1 });
    if (latest) statuses.set(stageId, latest.status);
  }
  return statuses;
}

export function getLineStatus(repoPath: string, lineId: string): LineStatus {
  const resolved = path.resolve(repoPath);
  const program = readInstalledLineProgram(resolved, lineId);
  if (!program) {
    throw new Error(
      `Line not installed: ${lineId}. Install one with "har line add <spec>" or scaffold with "har line create <id>".`,
    );
  }

  const ledger = readLineLedger(resolved);
  const entry = ledger?.lines.find((l) => l.id === lineId);
  const registry = readStageRegistry(resolved);
  const registeredIds = new Set(registry.stages.map((s) => s.id));
  const verificationStages = registry.verificationStages ?? [];

  const allGateStageIds = [...new Set(program.gate.stages.map((s) => s.id))];
  const runStatuses = latestRunStatusByStage(resolved, allGateStageIds);

  const stations: LineStationStatus[] = program.stations.map((station, index) => {
    const required = cumulativeGateStages(program, station.id);
    const requiredStageIds = [...new Set(required.map((s) => s.id))];
    const missingStageIds = requiredStageIds.filter((id) => !registeredIds.has(id));
    const passedStageIds = requiredStageIds.filter((id) => runStatuses.get(id) === 'pass');
    const neverRunStageIds = requiredStageIds.filter((id) => !runStatuses.has(id));
    return {
      id: station.id,
      title: station.title,
      index,
      requiredStageIds,
      passedStageIds,
      neverRunStageIds,
      missingStageIds,
      green: missingStageIds.length === 0 && passedStageIds.length === requiredStageIds.length,
      work: station.work,
    };
  });

  let currentStationId: string | undefined;
  for (const station of stations) {
    if (station.green) currentStationId = station.id;
    else break;
  }
  const nextStationId = stations.find((s) => !s.green)?.id;

  const lineStageIds = entry?.stageIds ?? [];
  const verifyLeaks = lineStageIds.filter((id) => verificationStages.includes(id));

  const warnings: string[] = [];
  if (verifyLeaks.length > 0) {
    warnings.push(
      `Line stage(s) ${verifyLeaks.join(', ')} are listed in verificationStages — ` +
        'line gate stages must stay off `har env verify --full`. Remove them from .har/stages.json.',
    );
  }
  for (const station of stations) {
    for (const missing of station.missingStageIds) {
      warnings.push(`Gate stage "${missing}" (station ${station.id}) is not registered in .har/stages.json`);
    }
  }

  const slotsInFlight: LineSlotInFlight[] = listSlotRegistryEntries(resolved).map((slot) => ({
    agentId: slot.agentId,
    branch: slot.branch,
    workUnitId: slot.workUnitId,
    workDir: slot.workDir,
  }));

  return {
    lineId,
    title: program.title,
    programPath: entry?.programPath ?? `.har/lines/${lineId}/line.json`,
    installed: true,
    source: entry?.source,
    stations,
    currentStationId,
    nextStationId,
    optInEnv: program.gate.optInEnv,
    registeredStageIds: lineStageIds,
    verifyLeaks,
    slotsInFlight,
    handoffAutonomousShip: false,
    warnings: [...new Set(warnings)],
  };
}

/** Status for every installed line. */
export function getAllLineStatuses(repoPath: string): LineStatus[] {
  return listInstalledLineIds(repoPath).map((id) => getLineStatus(repoPath, id));
}

export interface RunLineGateOptions {
  repoPath: string;
  lineId?: string;
  station: string;
  agentId?: number;
  /** Run even when the program declares an opt-in env var that is not set. */
  force?: boolean;
}

export interface LineGateStageResult {
  stageId: string;
  fromStation: string;
  status: StageResult['status'] | 'skipped';
  durationMs?: number;
  reason?: string;
}

export interface RunLineGateResult {
  lineId: string;
  station: string;
  /** Cumulative set actually considered, in station order. */
  stages: LineGateStageResult[];
  pass: boolean;
  skipped: boolean;
  skipReason?: string;
}

function resolveLineId(repoPath: string, lineId?: string): string {
  if (lineId) return lineId;
  const ids = listInstalledLineIds(repoPath);
  if (ids.length === 0) {
    throw new Error('No factory line installed. Run "har line create <id>" or "har line add <spec>".');
  }
  if (ids.length > 1) {
    throw new Error(`Multiple lines installed (${ids.join(', ')}). Pass --line <id>.`);
  }
  return ids[0];
}

/**
 * Run the cumulative gate for one station.
 *
 * Runs the tagged stages through `RunService.runStage` — the same executor and
 * the same `.har/runs/` records as any other stage. It never calls verify and
 * never adds these stages to the verify plan.
 */
export async function runLineGate(options: RunLineGateOptions): Promise<RunLineGateResult> {
  const repoPath = path.resolve(options.repoPath);
  const lineId = resolveLineId(repoPath, options.lineId);
  const program = readInstalledLineProgram(repoPath, lineId);
  if (!program) {
    throw new Error(`Line not installed: ${lineId}`);
  }

  const required = cumulativeGateStages(program, options.station);

  if (program.gate.optInEnv && !options.force && process.env[program.gate.optInEnv] !== '1') {
    return {
      lineId,
      station: options.station,
      stages: required.map((stage) => ({
        stageId: stage.id,
        fromStation: stage.fromStation,
        status: 'skipped' as const,
        reason: `${program.gate.optInEnv} is not "1"`,
      })),
      pass: true,
      skipped: true,
      skipReason: `Gate is opt-in: set ${program.gate.optInEnv}=1 (or pass --force) to run it.`,
    };
  }

  const registry = readStageRegistry(repoPath);
  const registeredIds = new Set(registry.stages.map((s) => s.id));

  // Stages that need a slot fail deep inside the runner with a bare "invalid
  // agent slot id"; say which stages and what to pass instead.
  if (options.agentId === undefined) {
    const needSlot = required
      .filter((stage) => registry.stages.find((s) => s.id === stage.id)?.requiresAgentId)
      .map((stage) => stage.id);
    if (needSlot.length > 0) {
      throw new Error(
        `Gate stage(s) ${needSlot.join(', ')} run in an agent slot — pass --agent <id> ` +
          `(har line gate ${options.station} --line ${lineId} --agent 1).`,
      );
    }
  }

  const results: LineGateStageResult[] = [];
  let pass = true;

  for (const stage of required) {
    if (!registeredIds.has(stage.id)) {
      results.push({
        stageId: stage.id,
        fromStation: stage.fromStation,
        status: 'skipped',
        reason: 'stage is not registered in .har/stages.json',
      });
      pass = false;
      continue;
    }

    const result = await runStage({
      repoPath,
      stageId: stage.id,
      agentId: options.agentId,
      trigger: 'cli',
    });
    results.push({
      stageId: stage.id,
      fromStation: stage.fromStation,
      status: result.status,
      durationMs: result.durationMs,
    });
    if (result.status !== 'pass') {
      pass = false;
    }
  }

  return { lineId, station: options.station, stages: results, pass, skipped: false };
}

/** Scaffold a project-owned line at `.har/lines/<id>/`. */
export function createLineBundle(
  repoPath: string,
  options: CreateLineOptions,
): CreateLineResult {
  return createLine(repoPath, options);
}

/** Install a line bundle (path → git → bundled id → npm). */
export function addLine(
  repoPath: string,
  spec: string,
  options: ApplyLineOptions = {},
): ApplyLineResult {
  return applyLine(repoPath, spec, options);
}
