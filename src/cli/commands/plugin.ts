import * as path from 'path';
import type { Argv } from 'yargs';
import { finishCommand } from '../finish-command';
import { createLocalPlugin } from '../../harness/plugin-create';
import { listLocalPluginIds } from '../../harness/plugin-resolve';
import { listPluginIds } from '../../harness/plugins';
import type { HarnessStageKind } from '../../harness/schema';
import { divider, error, header, info, success } from '../../utils/logging';

export async function handlePluginCreate(argv: {
  id?: string;
  repo: string;
  kind?: string;
  description?: string;
  packageFragment: boolean;
  force: boolean;
}): Promise<void> {
  if (!argv.id) {
    error('Missing plugin id. Usage: har plugin create <id> [--kind test] [--description "..."]');
    return finishCommand(1);
  }

  const repoPath = path.resolve(argv.repo);
  header('har plugin create');
  info(`Repository: ${repoPath}`);
  info(`Plugin: ${argv.id}`);

  try {
    const result = createLocalPlugin(repoPath, {
      id: argv.id,
      kind: argv.kind as HarnessStageKind | undefined,
      description: argv.description,
      packageFragment: argv.packageFragment,
      force: argv.force,
    });

    divider();
    success(`Local plugin scaffolded: .har/plugins/${result.pluginId}/`);
    for (const file of result.filesWritten) {
      info(`  + ${file}`);
    }
    console.error('');
    console.error('  Next steps:');
    for (const step of result.nextSteps) {
      console.error(`    ${step}`);
    }
    console.error('');
    console.error(`  Docs: .har/plugins/${result.pluginId}/README.md`);
    console.error('');
  } catch (err: unknown) {
    error((err as Error).message);
    return finishCommand(1);
  }
}

function handlePluginList(argv: { repo: string }): void {
  const repoPath = path.resolve(argv.repo);
  for (const id of listPluginIds()) {
    console.log(`${id}\t(bundled)`);
  }
  for (const id of listLocalPluginIds(repoPath)) {
    console.log(`${id}\t(local: .har/plugins/${id})`);
  }
}

export const pluginCommand = {
  command: 'plugin <subcommand>',
  describe: 'Author HAR plugins (project-owned under .har/plugins/, publishable to npm/git as-is)',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'create [id]',
        'Scaffold a project-owned plugin at .har/plugins/<id>/ (manifest, stage script, README)',
        (y: Argv) =>
          y
            .positional('id', {
              type: 'string',
              describe: 'Plugin id (lowercase slug, e.g. db-integrity)',
            })
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('kind', {
              type: 'string',
              describe:
                'Stage kind for the scaffolded stage (setup, launch, verify, test, inspect, reset, teardown, custom; default: test)',
            })
            .option('description', {
              type: 'string',
              describe: 'Stage description shown in the registry and Mission Control',
            })
            .option('package-fragment', {
              type: 'boolean',
              default: false,
              describe: 'Also scaffold package.fragment.json (merged into package.json on install)',
            })
            .option('force', {
              type: 'boolean',
              default: false,
              describe: 'Overwrite an existing .har/plugins/<id>/ directory',
            }),
        (argv) =>
          handlePluginCreate({
            id: argv.id as string | undefined,
            repo: argv.repo as string,
            kind: argv.kind as string | undefined,
            description: argv.description as string | undefined,
            packageFragment: argv['package-fragment'] as boolean,
            force: argv.force as boolean,
          }),
      )
      .command(
        'list',
        'List plugins available to this repository (bundled and local)',
        (y: Argv) => y.option('repo', { type: 'string', default: '.', describe: 'Path to the repository' }),
        (argv) => handlePluginList({ repo: argv.repo as string }),
      )
      .demandCommand(1, 'Please specify a subcommand: create, list'),
  handler: () => {},
};
