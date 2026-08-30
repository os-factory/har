import * as path from 'path';
import type { Argv } from 'yargs';
import { finishCommand } from '../finish-command';
import {
  addLine,
  createLineBundle,
  getAllLineStatuses,
  getLineStatus,
  listInstalledLineIds,
  runLineGate,
  type LineStatus,
} from '../../core/lines';
import { listBundledLineIds, listLocalLineIds } from '../../harness/line-resolve';
import { divider, error, header, info, success, warn } from '../../utils/logging';

function handleLineCreate(argv: {
  id?: string;
  repo: string;
  title?: string;
  description?: string;
  stations?: string[];
  gateStage: boolean;
  optInEnv?: string;
  force: boolean;
}): Promise<void> | void {
  if (!argv.id) {
    error('Missing line id. Usage: har line create <id> [--stations S1,S2] [--title "..."]');
    return finishCommand(1);
  }

  const repoPath = path.resolve(argv.repo);
  header('har line create');
  info(`Repository: ${repoPath}`);
  info(`Line: ${argv.id}`);

  try {
    const result = createLineBundle(repoPath, {
      id: argv.id,
      title: argv.title,
      description: argv.description,
      stations: argv.stations,
      gateStage: argv.gateStage,
      optInEnv: argv.optInEnv,
      force: argv.force,
    });

    divider();
    success(`Factory line scaffolded: .har/lines/${result.lineId}/`);
    for (const file of result.filesWritten) {
      info(`  + ${file}`);
    }
    console.error('');
    console.error('  Next steps:');
    for (const step of result.nextSteps) {
      console.error(`    ${step}`);
    }
    console.error('');
    console.error(`  Docs: .har/lines/${result.lineId}/README.md`);
    console.error('');
  } catch (err: unknown) {
    error((err as Error).message);
    return finishCommand(1);
  }
}

function handleLineAdd(argv: {
  spec?: string;
  repo: string;
  force: boolean;
}): Promise<void> | void {
  if (!argv.spec) {
    error('Missing line spec. Usage: har line add <id|path|npm|git>');
    return finishCommand(1);
  }

  const repoPath = path.resolve(argv.repo);
  header('har line add');
  info(`Repository: ${repoPath}`);
  info(`Line: ${argv.spec}`);

  try {
    const result = addLine(repoPath, argv.spec, { force: argv.force, spec: argv.spec });
    divider();
    console.error('');
    console.error('  verificationStages unchanged — line gate stages are opt-in.');
    console.error(
      `  Run the gate with: har line gate ${result.firstGatedStationId} --line ${result.lineId}`,
    );
    console.error('');
    console.error('  Next steps:');
    for (const step of result.nextSteps) {
      console.error(`    ${step}`);
    }
    console.error('');
  } catch (err: unknown) {
    error((err as Error).message);
    return finishCommand(1);
  }
}

function renderStatus(status: LineStatus): void {
  header(`Line: ${status.lineId} — ${status.title}`);
  info(`Program: ${status.programPath}${status.source ? ` (source: ${status.source})` : ''}`);
  info(
    status.optInEnv
      ? `Gate: opt-in via ${status.optInEnv}=1`
      : 'Gate: on demand (har line gate <station>)',
  );
  info(
    status.registeredStageIds.length > 0
      ? `Registered stages (off verify): ${status.registeredStageIds.join(', ')}`
      : 'Registered stages (off verify): none',
  );
  console.error('');

  for (const station of status.stations) {
    const marker = station.green ? '✓' : station.id === status.nextStationId ? '▶' : '·';
    const required =
      station.requiredStageIds.length > 0
        ? `${station.passedStageIds.length}/${station.requiredStageIds.length} gate stages green`
        : 'no gate stages';
    console.error(`  ${marker} ${station.id}  ${station.title}  — ${required}`);
    if (station.missingStageIds.length > 0) {
      console.error(`      missing (not registered): ${station.missingStageIds.join(', ')}`);
    }
    const pending = station.requiredStageIds.filter((id) => !station.passedStageIds.includes(id));
    if (pending.length > 0 && station.missingStageIds.length === 0) {
      console.error(`      pending: ${pending.join(', ')}`);
    }
  }
  console.error('');

  if (status.slotsInFlight.length > 0) {
    console.error('  Slots in flight:');
    for (const slot of status.slotsInFlight) {
      const work = slot.workUnitId ? ` work=${slot.workUnitId}` : '';
      console.error(`    agent ${slot.agentId}: ${slot.branch ?? slot.workDir}${work}`);
    }
    console.error('');
  }

  for (const warning of status.warnings) {
    warn(`  ⚠ ${warning}`);
  }

  console.error(
    status.nextStationId
      ? `  Next station: ${status.nextStationId}`
      : '  All stations green — hand off for human review (autonomousShip: false).',
  );
  console.error('');
}

function handleLineStatus(argv: { id?: string; repo: string; json: boolean }): Promise<void> | void {
  const repoPath = path.resolve(argv.repo);
  try {
    const statuses = argv.id ? [getLineStatus(repoPath, argv.id)] : getAllLineStatuses(repoPath);
    if (argv.json) {
      console.log(JSON.stringify(argv.id ? statuses[0] : statuses, null, 2));
      return;
    }
    if (statuses.length === 0) {
      info('No factory line installed.');
      info('Scaffold one: har line create <id>   •   Install one: har line add <spec>');
      return;
    }
    for (const status of statuses) {
      renderStatus(status);
    }
  } catch (err: unknown) {
    error((err as Error).message);
    return finishCommand(1);
  }
}

async function handleLineGate(argv: {
  station?: string;
  repo: string;
  line?: string;
  agent?: number;
  force: boolean;
  json: boolean;
}): Promise<void> {
  if (!argv.station) {
    error('Missing station. Usage: har line gate <station> [--line <id>] [--agent <slot>]');
    return finishCommand(1);
  }

  const repoPath = path.resolve(argv.repo);
  try {
    const result = await runLineGate({
      repoPath,
      lineId: argv.line,
      station: argv.station,
      agentId: argv.agent,
      force: argv.force,
    });

    if (argv.json) {
      console.log(JSON.stringify(result, null, 2));
      return finishCommand(result.pass ? 0 : 1);
    }

    header(`har line gate ${result.station} (${result.lineId})`);
    if (result.skipped) {
      info(result.skipReason ?? 'Gate skipped.');
      for (const stage of result.stages) {
        info(`  · ${stage.stageId} (from ${stage.fromStation}) — skipped`);
      }
      return;
    }

    for (const stage of result.stages) {
      const mark = stage.status === 'pass' ? '✓' : stage.status === 'skipped' ? '·' : '✗';
      const detail = stage.reason ? ` — ${stage.reason}` : '';
      const ms = stage.durationMs !== undefined ? ` (${Math.round(stage.durationMs / 100) / 10}s)` : '';
      console.error(`  ${mark} ${stage.stageId}  from ${stage.fromStation}  ${stage.status}${ms}${detail}`);
    }
    divider();
    if (result.pass) {
      success(`Gate passed for station ${result.station}`);
    } else {
      error(`Gate failed for station ${result.station}`);
    }
    return finishCommand(result.pass ? 0 : 1);
  } catch (err: unknown) {
    error((err as Error).message);
    return finishCommand(1);
  }
}

function handleLineList(argv: { repo: string }): void {
  const repoPath = path.resolve(argv.repo);
  const installed = new Set(listInstalledLineIds(repoPath));
  for (const id of listBundledLineIds()) {
    console.log(`${id}\t(bundled)`);
  }
  for (const id of listLocalLineIds(repoPath)) {
    console.log(`${id}\t(local: .har/lines/${id})${installed.has(id) ? ' [installed]' : ''}`);
  }
}

function parseStations(value: unknown): string[] | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const lineCommand = {
  command: 'line <subcommand>',
  describe:
    'Factory lines: multi-station programs with a cumulative gate that never joins verificationStages',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'create [id]',
        'Scaffold a project-owned line at .har/lines/<id>/ (manifest, program, gate stage, README)',
        (y: Argv) =>
          y
            .positional('id', { type: 'string', describe: 'Line id (lowercase slug, e.g. onboarding-line)' })
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('title', { type: 'string', describe: 'Human-readable line title' })
            .option('description', { type: 'string', describe: 'One-paragraph description of the program' })
            .option('stations', {
              type: 'string',
              describe: 'Comma-separated station ids in order (default: S1,S2)',
            })
            .option('gate-stage', {
              type: 'boolean',
              default: true,
              describe: 'Scaffold one registered-but-off-verify gate stage',
            })
            .option('opt-in-env', {
              type: 'string',
              describe: 'Env var that must be "1" for the gate to run (e.g. HAR_FIXTURE_E2E)',
            })
            .option('force', { type: 'boolean', default: false, describe: 'Overwrite an existing line' }),
        (argv) =>
          handleLineCreate({
            id: argv.id as string | undefined,
            repo: argv.repo as string,
            title: argv.title as string | undefined,
            description: argv.description as string | undefined,
            stations: parseStations(argv.stations),
            gateStage: argv['gate-stage'] as boolean,
            optInEnv: argv['opt-in-env'] as string | undefined,
            force: argv.force as boolean,
          }),
      )
      .command(
        'add [spec]',
        'Install a line bundle (local id, path, npm package, or git URL) — never touches verificationStages',
        (y: Argv) =>
          y
            .positional('spec', {
              type: 'string',
              describe: 'Line id, path (./line), npm package (@org/pkg), or git URL (github:org/repo)',
            })
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('force', {
              type: 'boolean',
              default: false,
              describe: 'Overwrite existing line files and stage entries',
            }),
        (argv) =>
          handleLineAdd({
            spec: argv.spec as string | undefined,
            repo: argv.repo as string,
            force: argv.force as boolean,
          }),
      )
      .command(
        'status [id]',
        'Show stations, cumulative gate progress from run records, and slots in flight',
        (y: Argv) =>
          y
            .positional('id', { type: 'string', describe: 'Line id (default: all installed lines)' })
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('json', { type: 'boolean', default: false, describe: 'Emit structured JSON' }),
        (argv) =>
          handleLineStatus({
            id: argv.id as string | undefined,
            repo: argv.repo as string,
            json: argv.json as boolean,
          }),
      )
      .command(
        'gate [station]',
        'Run the cumulative gate for a station (does NOT run verify and does not widen it)',
        (y: Argv) =>
          y
            .positional('station', { type: 'string', describe: 'Station id (e.g. S1)' })
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('line', { type: 'string', describe: 'Line id when more than one is installed' })
            .option('agent', { type: 'number', describe: 'Agent slot to run the stages in' })
            .option('force', {
              type: 'boolean',
              default: false,
              describe: 'Run even when the program declares an opt-in env var that is not set',
            })
            .option('json', { type: 'boolean', default: false, describe: 'Emit structured JSON' }),
        (argv) =>
          handleLineGate({
            station: argv.station as string | undefined,
            repo: argv.repo as string,
            line: argv.line as string | undefined,
            agent: argv.agent as number | undefined,
            force: argv.force as boolean,
            json: argv.json as boolean,
          }),
      )
      .command(
        'list',
        'List lines available to this repository (bundled and local)',
        (y: Argv) => y.option('repo', { type: 'string', default: '.', describe: 'Path to the repository' }),
        (argv) => handleLineList({ repo: argv.repo as string }),
      )
      .demandCommand(1, 'Please specify a subcommand: create, add, status, gate, list'),
  handler: () => {},
};
