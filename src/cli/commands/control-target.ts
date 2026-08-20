import * as path from 'path';
import type { Argv } from 'yargs';
import { describePortalTarget } from '../../core/control-config';
import { canonicalizeControlRepoPath } from '../../core/control-repo-path';
import {
  getPortalTargetRecord,
  listPortalTargetRecords,
  redactPortalTargetRecord,
  removePortalTarget,
  renamePortalTarget,
  recordToPortalTarget,
  setDefaultPortalTarget,
  setRepoPortalTarget,
} from '../../core/portal-targets';
import { error, header, info, success } from '../../utils/logging';
import { finishCommand } from '../finish-command';

export function registerControlTargetCommand(yargs: Argv): Argv {
  return yargs.command(
    'target',
    'Manage named hosted portal targets (credentials stay in ~/.har/)',
    (y) =>
      y
        .command({
          command: 'list',
          describe: 'List saved portal targets',
          builder: (yy: Argv) => yy.option('json', { type: 'boolean', default: false }),
          handler: (argv) => handleTargetList(argv as { json: boolean }),
        })
        .command({
          command: 'show <alias>',
          describe: 'Show one portal target',
          builder: (yy: Argv) => yy.option('json', { type: 'boolean', default: false }),
          handler: (argv) =>
            handleTargetShow(argv as unknown as { alias: string; json: boolean }),
        })
        .command({
          command: 'use <alias>',
          describe: 'Select the default portal target',
          builder: (yy: Argv) =>
            yy
              .option('repo', {
                type: 'string',
                describe: 'Repository path (omit to set the global default target)',
              })
              .option('json', { type: 'boolean', default: false }),
          handler: (argv) =>
            handleTargetUse(argv as unknown as { alias: string; repo?: string; json: boolean }),
        })
        .command({
          command: 'remove <alias>',
          describe: 'Remove a saved portal target',
          builder: (yy: Argv) => yy.option('json', { type: 'boolean', default: false }),
          handler: (argv) =>
            handleTargetRemove(argv as unknown as { alias: string; json: boolean }),
        })
        .command({
          command: 'rename <alias> <newAlias>',
          describe: 'Rename a portal target alias',
          builder: (yy: Argv) => yy.option('json', { type: 'boolean', default: false }),
          handler: (argv) =>
            handleTargetRename(
              argv as unknown as { alias: string; newAlias: string; json: boolean },
            ),
        })
        .demandCommand(1, 'Specify a target action: list, show, use, remove, rename'),
    () => {},
  );
}

async function handleTargetList(argv: { json: boolean }): Promise<void> {
  const targets = listPortalTargetRecords().map(redactPortalTargetRecord);
  if (argv.json) {
    process.stdout.write(JSON.stringify({ targets }, null, 2) + '\n');
    return;
  }

  header('har control target list');
  if (targets.length === 0) {
    info('No portal targets saved yet.');
    info('Add one with: har control login --target <alias> --portal <url>');
    return;
  }

  for (const target of targets) {
    const workspace =
      typeof target.workspaceName === 'string'
        ? target.workspaceName
        : typeof target.workspaceSlug === 'string'
          ? target.workspaceSlug
          : target.workspaceId;
    info(`${target.alias}: ${target.portalUrl} — ${workspace}`);
  }
}

async function handleTargetShow(argv: { alias: string; json: boolean }): Promise<void> {
  const record = getPortalTargetRecord(argv.alias);
  if (!record) {
    error(`Unknown target "${argv.alias}".`);
    return finishCommand(1);
  }
  const payload = redactPortalTargetRecord(record);
  if (argv.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }
  header(`har control target show ${record.alias}`);
  for (const [key, value] of Object.entries(payload)) {
    info(`${key}: ${String(value)}`);
  }
}

async function handleTargetUse(argv: {
  alias: string;
  repo?: string;
  json: boolean;
}): Promise<void> {
  try {
    if (argv.repo) {
      const repoPath = canonicalizeControlRepoPath(path.resolve(argv.repo));
      const record = setRepoPortalTarget(repoPath, argv.alias);
      if (argv.json) {
        process.stdout.write(
          JSON.stringify({ repoPath, target: redactPortalTargetRecord(record) }, null, 2) + '\n',
        );
        return;
      }
      header('har control target use');
      success(
        `Repository ${repoPath} → target ${record.alias} (${describePortalTarget(recordToPortalTarget(record))})`,
      );
      return;
    }

    const record = setDefaultPortalTarget(argv.alias);
    if (argv.json) {
      process.stdout.write(
        JSON.stringify({ defaultTarget: redactPortalTargetRecord(record) }, null, 2) + '\n',
      );
      return;
    }
    header('har control target use');
    success(
      `Default portal target: ${record.alias} (${describePortalTarget(recordToPortalTarget(record))})`,
    );
  } catch (err) {
    error((err as Error).message);
    return finishCommand(1);
  }
}

async function handleTargetRemove(argv: { alias: string; json: boolean }): Promise<void> {
  const removed = removePortalTarget(argv.alias);
  if (!removed) {
    error(`Unknown target "${argv.alias}".`);
    return finishCommand(1);
  }
  if (argv.json) {
    process.stdout.write(JSON.stringify({ removed: argv.alias }, null, 2) + '\n');
    return;
  }
  header('har control target remove');
  success(`Removed target ${argv.alias}`);
}

async function handleTargetRename(argv: {
  alias: string;
  newAlias: string;
  json: boolean;
}): Promise<void> {
  try {
    const record = renamePortalTarget(argv.alias, argv.newAlias);
    if (argv.json) {
      process.stdout.write(JSON.stringify({ target: redactPortalTargetRecord(record) }, null, 2) + '\n');
      return;
    }
    header('har control target rename');
    success(`Renamed ${argv.alias} → ${record.alias}`);
  } catch (err) {
    error((err as Error).message);
    return finishCommand(1);
  }
}
