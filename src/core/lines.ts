import * as path from 'path';
import {
  applyLine,
  installedLineScopes,
  lineProgramPathRel,
  locateInstalledLine,
  readInstalledLineProgram,
  type ApplyLineOptions,
  type ApplyLineResult,
} from '../harness/lines';
import { createLine, type CreateLineOptions, type CreateLineResult } from '../harness/line-create';
import { readAllLineLedgerEntries, readLineLedger } from '../harness/line-ledger';
import { listBundledLineIds, listLocalLineIds } from '../harness/line-resolve';
import { LINE_SCOPES, type LineScope } from '../harness/line-scope';
import { readStageRegistry, stageRequiresAgentId } from '../harness/stages';
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
  /** `team` (committed `.har/lines/`) or `personal` (gitignored `.har/local/lines/`). */
  scope: LineScope;
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

/**
 * Ids of every line installed in this repo, team and personal (ledgers first,
 * then on-disk). An id in both scopes is listed once; resolving it reports the clash.
 */
export function listInstalledLineIds(repoPath: string): string[] {
  const fromLedger = readAllLineLedgerEntries(repoPath).map((l) => l.id);
  const onDisk = LINE_SCOPES.flatMap((scope) =>
    listLocalLineIds(repoPath, scope).filter(
      (id) => readInstalledLineProgram(repoPath, id, scope) !== null,
    ),
  );
  return [...new Set([...fromLedger, ...onDisk])].sort();
}

/** Line ids installed in both scopes — each is an error to resolve. */
export function listLineScopeClashes(repoPath: string): string[] {
  return listInstalledLineIds(repoPath).filter((id) => installedLineScopes(repoPath, id).length > 1);
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
  const scope = locateInstalledLine(resolved, lineId);
  const program = scope ? readInstalledLineProgram(resolved, lineId, scope) : null;
  if (!scope || !program) {
    throw new Error(
      `Line not installed: ${lineId}. Install one with "har line add <spec>" or scaffold with "har line create <id>".`,
    );
  }

  const ledger = readLineLedger(resolved, scope);
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
    scope,
    programPath: entry?.programPath ?? lineProgramPathRel(lineId, scope),
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

const REASON_TAIL_LINES = 5;

/**
 * Why a gate stage failed, so a caller need not open the run record: the
 * `output` field of the stage's JSON result (the stage script contract), else
 * the end of its stderr, where scripts print errors.
 */
function failureReason(result: StageResult): string | undefined {
  const reported = (result as { output?: unknown }).output;
  const pick = (stream: string) =>
    result.logs.filter((log) => log.stream === stream && log.content?.trim()).pop()?.content;
  const text =
    (typeof reported === 'string' && reported.trim() ? reported : undefined) ??
    pick('stderr') ??
    pick('stdout') ??
    pick('combined');
  if (!text) return result.code !== undefined ? `exit code ${result.code}` : undefined;
  return text.trim().split('\n').slice(-REASON_TAIL_LINES).join('\n');
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
      ...(result.status !== 'pass' ? { reason: failureReason(result) } : {}),
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

/** How to run every station of a line at once: its last station's cumulative gate. */
export interface LineRunAll {
  station: string;
  /** True when the program declares an opt-in env var; running it on purpose bypasses that. */
  force: boolean;
  command: string;
}

/**
 * Slot to name in a gate command: the slot that was just verified, a
 * `<slot>` placeholder when a gate stage runs in a slot, or none.
 */
type GateSlot = number | '<slot>' | undefined;

function gateSlot(
  registry: ReturnType<typeof readStageRegistry>,
  program: LineProgram,
  agentId?: number,
): GateSlot {
  if (agentId !== undefined) return agentId;
  const needsSlot = program.gate.stages.some((gateStage) => {
    const stage = registry.stages.find((s) => s.id === gateStage.id);
    return stage !== undefined && stageRequiresAgentId(stage);
  });
  return needsSlot ? '<slot>' : undefined;
}

function gateCommand(lineId: string, station: string, slot: GateSlot, force: boolean): string {
  const agent = slot === undefined ? '' : ` --agent ${slot}`;
  return `har line gate ${station} --line ${lineId}${agent}${force ? ' --force' : ''}`;
}

function lineRunAll(lineId: string, program: LineProgram, slot: GateSlot): LineRunAll | undefined {
  const last = program.stations[program.stations.length - 1];
  if (!last) return undefined;
  const force = program.gate.optInEnv !== null;
  return { station: last.id, force, command: gateCommand(lineId, last.id, slot, force) };
}

/** One installed line in `har line list` / `har_line_list`. */
export interface LineListEntry {
  lineId: string;
  title: string;
  /** `team` or `personal`; absent when the line is unreadable. */
  scope?: LineScope;
  description?: string;
  stationIds: string[];
  /** First station that is not green; undefined when every station is green. */
  nextStationId?: string;
  allGreen: boolean;
  optInEnv: string | null;
  runAll?: LineRunAll;
  /** Set when the line's program cannot be read; nothing else about it is known. */
  unreadable?: string;
}

/** A line this repo could install but has not. */
export interface AvailableLine {
  lineId: string;
  source: 'bundled' | 'local';
  /** For a `local` line: the home it was authored in (install it with that scope). */
  scope?: LineScope;
}

export interface LineList {
  installed: LineListEntry[];
  available: AvailableLine[];
}

function safeLedgerIds(repoPath: string): string[] {
  return readAllLineLedgerEntries(repoPath).map((l) => l.id);
}

/**
 * Installed lines with what an agent needs to decide whether to run one, plus
 * lines available to install. Never throws on a broken line: it is listed as
 * `unreadable` so one bad file cannot hide the others. With `agentId`, run
 * commands target that slot.
 */
export function listLines(repoPath: string, options: { agentId?: number } = {}): LineList {
  const resolved = path.resolve(repoPath);
  const registry = readStageRegistry(resolved);
  const ledgerIds = new Set(safeLedgerIds(resolved));
  const personalLocalIds = new Set(listLocalLineIds(resolved, 'personal'));
  const localIds = [...listLocalLineIds(resolved, 'team'), ...personalLocalIds];
  const installed: LineListEntry[] = [];
  const available: AvailableLine[] = [];

  for (const lineId of [...new Set([...ledgerIds, ...localIds])].sort()) {
    let program: LineProgram | null;
    try {
      program = readInstalledLineProgram(resolved, lineId);
    } catch (err: unknown) {
      installed.push(unreadableEntry(lineId, `cannot read line.json: ${(err as Error).message}`));
      continue;
    }
    if (!program) {
      if (ledgerIds.has(lineId)) {
        installed.push(unreadableEntry(lineId, 'line.json is missing or invalid'));
      } else {
        available.push({
          lineId,
          source: 'local',
          scope: personalLocalIds.has(lineId) ? 'personal' : 'team',
        });
      }
      continue;
    }
    let nextStationId: string | undefined;
    try {
      nextStationId = getLineStatus(resolved, lineId).nextStationId;
    } catch (err: unknown) {
      installed.push(unreadableEntry(lineId, (err as Error).message));
      continue;
    }
    installed.push({
      lineId,
      title: program.title,
      // The program read above already ruled out a scope clash.
      scope: locateInstalledLine(resolved, lineId) ?? 'team',
      description: program.description,
      stationIds: program.stations.map((s) => s.id),
      nextStationId,
      allGreen: nextStationId === undefined,
      optInEnv: program.gate.optInEnv,
      runAll: lineRunAll(lineId, program, gateSlot(registry, program, options.agentId)),
    });
  }

  const known = new Set([...installed, ...available].map((l) => l.lineId));
  for (const lineId of listBundledLineIds()) {
    if (!known.has(lineId)) available.push({ lineId, source: 'bundled' });
  }
  return { installed, available };
}

function unreadableEntry(lineId: string, reason: string): LineListEntry {
  return {
    lineId,
    title: lineId,
    stationIds: [],
    allGreen: false,
    optInEnv: null,
    unreadable: reason,
  };
}

export interface LineDescriptionStation {
  id: string;
  title: string;
  description?: string;
  /** Cumulative gate stages required at this station. */
  gateStageIds: string[];
  green: boolean;
  work?: LineStation['work'];
}

export interface LineDescriptionGateStage {
  id: string;
  fromStation: string;
  description?: string;
  registered: boolean;
  /** Status of the latest run record, if the stage ever ran. */
  lastRunStatus?: string;
}

/** `har line describe` / `har_line_describe`: what a line checks and how to run it. */
export interface LineDescription {
  lineId: string;
  title: string;
  /** `team` (committed `.har/lines/`) or `personal` (gitignored `.har/local/lines/`). */
  scope: LineScope;
  description?: string;
  programPath: string;
  source?: string;
  optInEnv: string | null;
  stations: LineDescriptionStation[];
  gateStages: LineDescriptionGateStage[];
  nextStationId?: string;
  allGreen: boolean;
  runAll?: LineRunAll;
  /** Per-station command template; replace <station> with a station id. */
  runStationCommand: string;
  /** Line stages registered in .har/stages.json (and kept off the verify plan). */
  registeredStageIds: string[];
  /** Line stages that leaked onto verificationStages — doctor fails on these. */
  verifyLeaks: string[];
  slotsInFlight: LineSlotInFlight[];
  warnings: string[];
}

/** An installed line whose program cannot be read. */
export interface UnreadableLine {
  lineId: string;
  unreadable: string;
}

export function describeLine(repoPath: string, lineId: string): LineDescription {
  const resolved = path.resolve(repoPath);
  const status = getLineStatus(resolved, lineId);
  // getLineStatus has already proven the program exists and parses.
  const program = readInstalledLineProgram(resolved, lineId) as LineProgram;
  const registry = readStageRegistry(resolved);
  const registered = new Map(registry.stages.map((s) => [s.id, s]));
  const extraDescriptions = new Map(
    program.extraStages.map((s) => [s.id, s.description] as const),
  );
  const gateStageIds = [...new Set(program.gate.stages.map((s) => s.id))];
  const runStatuses = latestRunStatusByStage(resolved, gateStageIds);
  const stationStatus = new Map(status.stations.map((s) => [s.id, s]));

  const force = program.gate.optInEnv !== null;
  const slot = gateSlot(registry, program);
  return {
    lineId,
    title: program.title,
    scope: status.scope,
    description: program.description,
    programPath: status.programPath,
    source: status.source,
    optInEnv: program.gate.optInEnv,
    stations: program.stations.map((station) => ({
      id: station.id,
      title: station.title,
      description: station.description,
      gateStageIds: stationStatus.get(station.id)?.requiredStageIds ?? [],
      green: stationStatus.get(station.id)?.green ?? false,
      work: station.work,
    })),
    gateStages: program.gate.stages.map((stage) => ({
      id: stage.id,
      fromStation: stage.fromStation,
      description: registered.get(stage.id)?.description ?? extraDescriptions.get(stage.id),
      registered: registered.has(stage.id),
      lastRunStatus: runStatuses.get(stage.id),
    })),
    nextStationId: status.nextStationId,
    allGreen: status.nextStationId === undefined,
    runAll: lineRunAll(lineId, program, slot),
    runStationCommand: gateCommand(lineId, '<station>', slot, force),
    registeredStageIds: status.registeredStageIds,
    verifyLeaks: status.verifyLeaks,
    slotsInFlight: status.slotsInFlight,
    warnings: status.warnings,
  };
}

/**
 * Every installed line, described. A line that cannot be read is returned as
 * `unreadable` instead of failing the others.
 */
export function describeLines(repoPath: string): Array<LineDescription | UnreadableLine> {
  return listLines(repoPath).installed.map((entry) => {
    if (entry.unreadable) return { lineId: entry.lineId, unreadable: entry.unreadable };
    try {
      return describeLine(repoPath, entry.lineId);
    } catch (err: unknown) {
      return { lineId: entry.lineId, unreadable: (err as Error).message };
    }
  });
}
