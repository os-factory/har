import * as path from 'path';
import type { Argv } from 'yargs';
import { finishCommand } from '../finish-command';
import {
  addLine,
  createLineBundle,
  describeLine,
  describeLines,
  listLines,
  promoteLine,
  runLineGate,
  type LineDescription,
} from '../../core/lines';
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
  personal: boolean;
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
      scope: argv.personal ? 'personal' : 'team',
    });

    divider();
    success(
      `Factory line scaffolded: ${result.lineDirRel}/` +
        (result.scope === 'personal' ? ' (personal — gitignored, not shared with the team or CI)' : ''),
    );
    for (const file of result.filesWritten) {
      info(`  + ${file}`);
    }
    console.error('');
    console.error('  Next steps:');
    for (const step of result.nextSteps) {
      console.error(`    ${step}`);
    }
    console.error('');
    console.error(`  Docs: ${result.lineDirRel}/README.md`);
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
  personal: boolean;
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
    const result = addLine(repoPath, argv.spec, {
      force: argv.force,
      spec: argv.spec,
      scope: argv.personal ? 'personal' : 'team',
    });
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

function handleLinePromote(argv: { id?: string; repo: string; json: boolean }): Promise<void> | void {
  if (!argv.id) {
    error('Missing line id. Usage: har line promote <id>');
    return finishCommand(1);
  }
  const repoPath = path.resolve(argv.repo);
  try {
    const result = promoteLine(repoPath, argv.id);
    if (argv.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    header('har line promote');
    success(`Promoted ${result.lineId} to a team line: ${result.lineDirRel}/`);
    info(
      result.stageIds.length > 0
        ? `Moved stage(s) to .har/stages.json (NOT on verify): ${result.stageIds.join(', ')}`
        : 'No stages to move',
    );
    for (const warning of result.warnings) warn(warning);
    divider();
    console.error('');
    console.error('  Teammates and CI see it once you commit:');
    for (const step of result.nextSteps) {
      console.error(`    ${step}`);
    }
    console.error('');
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

/** First sentence of a description, for one-line listings. */
function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(\s|$)/s.exec(text.trim());
  return (match ? match[1] : text.trim()).replace(/\s+/g, ' ');
}

function handleLineList(argv: { repo: string; json: boolean }): void {
  const list = listLines(path.resolve(argv.repo));
  if (argv.json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }

  if (list.installed.length === 0) {
    console.log('No factory line installed.');
  } else {
    console.log('Installed lines (never run by "har env verify" unless picked):');
    for (const line of list.installed) {
      if (line.unreadable) {
        console.log(`  ✗ ${line.lineId}  unreadable — ${line.unreadable}`);
        continue;
      }
      const progress = line.allGreen ? 'all stations green' : `next: ${line.nextStationId}`;
      const scope = line.scope === 'personal' ? '  [personal]' : '';
      console.log(`  ${line.lineId}  ${line.title}${scope}  (${line.stationIds.join(' → ')}; ${progress})`);
      if (line.description) console.log(`      ${firstSentence(line.description)}`);
      if (line.runAll) console.log(`      run every station: ${line.runAll.command}`);
    }
  }

  if (list.available.length > 0) {
    console.log('');
    console.log('Available to install (har line add <id>):');
    for (const line of list.available) {
      const where =
        line.source !== 'local'
          ? 'bundled'
          : line.scope === 'personal'
            ? `personal: .har/local/lines/${line.lineId} — add with --personal`
            : `local: .har/lines/${line.lineId}`;
      console.log(`  ${line.lineId}  (${where})`);
    }
  }

  console.log('');
  console.log(
    list.installed.length > 0
      ? 'What a line checks: har line describe <id>'
      : 'Scaffold one: har line create <id>   •   Install one: har line add <spec>',
  );
}

function renderDescription(line: LineDescription): void {
  console.log(`${line.lineId} — ${line.title}`);
  console.log(`Scope: ${line.scope}${line.scope === 'personal' ? ' (gitignored — yours only)' : ''}`);
  console.log(`Program: ${line.programPath}${line.source ? ` (source: ${line.source})` : ''}`);
  if (line.description) {
    console.log('');
    console.log(line.description);
  }

  console.log('');
  console.log('Stations (each one\'s gate includes every earlier station\'s stages):');
  for (const station of line.stations) {
    const marker = station.green ? '✓' : station.id === line.nextStationId ? '▶' : '·';
    const gate = station.gateStageIds.length > 0 ? station.gateStageIds.join(', ') : 'no gate stages';
    console.log(`  ${marker} ${station.id}  ${station.title}  — gate: ${gate}`);
    if (station.description) console.log(`      ${station.description}`);
  }

  console.log('');
  console.log('Gate stages:');
  if (line.gateStages.length === 0) console.log('  none');
  for (const stage of line.gateStages) {
    const state = !stage.registered
      ? 'not registered in .har/stages.json'
      : `last run: ${stage.lastRunStatus ?? 'never'}`;
    console.log(`  ${stage.id}  from ${stage.fromStation}  (${state})`);
    if (stage.description) console.log(`      ${stage.description}`);
  }

  console.log('');
  if (line.optInEnv) {
    console.log(`Opt-in: the gate only runs when ${line.optInEnv}=1, or with --force (used below).`);
  }
  console.log(
    line.registeredStageIds.length > 0
      ? `Registered stages (off verify): ${line.registeredStageIds.join(', ')}`
      : 'Registered stages (off verify): none',
  );
  if (line.slotsInFlight.length > 0) {
    console.log('Slots in flight:');
    for (const slot of line.slotsInFlight) {
      const work = slot.workUnitId ? ` work=${slot.workUnitId}` : '';
      console.log(`  agent ${slot.agentId}: ${slot.branch ?? slot.workDir}${work}`);
    }
  }

  console.log('');
  if (line.runAll) console.log(`Run every station: ${line.runAll.command}`);
  console.log(`Run one station:   ${line.runStationCommand}`);
  console.log(
    line.nextStationId
      ? `Next station: ${line.nextStationId}`
      : 'All stations green — hand off for human review (autonomousShip: false).',
  );
  // Warnings include any line stage that leaked onto verificationStages.
  for (const warning of line.warnings) {
    warn(`⚠ ${warning}`);
  }
}

function handleLineDescribe(argv: { id?: string; repo: string; json: boolean }): Promise<void> | void {
  const repoPath = path.resolve(argv.repo);
  try {
    if (argv.id) {
      const line = describeLine(repoPath, argv.id);
      if (argv.json) {
        console.log(JSON.stringify(line, null, 2));
        return;
      }
      renderDescription(line);
      return;
    }

    const lines = describeLines(repoPath);
    if (argv.json) {
      console.log(JSON.stringify({ lines }, null, 2));
      return;
    }
    if (lines.length === 0) {
      info('No factory line installed.');
      info('Scaffold one: har line create <id>   •   Install one: har line add <spec>');
      return;
    }
    lines.forEach((line, index) => {
      if (index > 0) console.log(`\n${'─'.repeat(60)}\n`);
      if ('unreadable' in line) {
        console.log(`✗ ${line.lineId}  unreadable — ${line.unreadable}`);
      } else {
        renderDescription(line);
      }
    });
  } catch (err: unknown) {
    error((err as Error).message);
    return finishCommand(1);
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
        'Scaffold a project-owned line at .har/lines/<id>/ (or .har/local/lines/<id>/ with --personal)',
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
            .option('force', { type: 'boolean', default: false, describe: 'Overwrite an existing line' })
            .option('personal', {
              type: 'boolean',
              default: false,
              describe: 'Scaffold under the gitignored .har/local/lines/ (yours only, not the team or CI)',
            }),
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
            personal: argv.personal as boolean,
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
            })
            .option('personal', {
              type: 'boolean',
              default: false,
              describe: 'Install under the gitignored .har/local/ (yours only, not the team or CI)',
            }),
        (argv) =>
          handleLineAdd({
            spec: argv.spec as string | undefined,
            repo: argv.repo as string,
            force: argv.force as boolean,
            personal: argv.personal as boolean,
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
        'promote [id]',
        'Share a personal line with the team: move it from .har/local/ into the committed .har/ (one way — there is no demote)',
        (y: Argv) =>
          y
            .positional('id', { type: 'string', describe: 'Personal line id' })
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('json', { type: 'boolean', default: false, describe: 'Emit structured JSON' }),
        (argv) =>
          handleLinePromote({
            id: argv.id as string | undefined,
            repo: argv.repo as string,
            json: argv.json as boolean,
          }),
      )
      .command(
        'list',
        'List installed lines (what each covers, progress, how to run it) and lines available to install',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('json', { type: 'boolean', default: false, describe: 'Emit structured JSON' }),
        (argv) => handleLineList({ repo: argv.repo as string, json: argv.json as boolean }),
      )
      .command(
        'describe [id]',
        'Show what an installed line checks and where it stands: stations, gate progress, gate stages, slots in flight, how to run it (all lines when no id)',
        (y: Argv) =>
          y
            .positional('id', { type: 'string', describe: 'Line id (default: every installed line)' })
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('json', { type: 'boolean', default: false, describe: 'Emit structured JSON' }),
        (argv) =>
          handleLineDescribe({
            id: argv.id as string | undefined,
            repo: argv.repo as string,
            json: argv.json as boolean,
          }),
      )
      .demandCommand(1, 'Please specify a subcommand: create, add, list, describe, gate'),
  handler: () => {},
};
