import * as path from 'path';
import type { Argv } from 'yargs';
import {
  checkCommitGate,
  getHooksStatus,
  installHooks,
  recordCommitAssociation,
  uninstallHooks,
} from '../../core/hooks';
import { error, info, success, warn } from '../../utils/logging';

interface RepoArgs {
  repo: string;
}

function repoOption(y: Argv) {
  return y.option('repo', { type: 'string', default: '.', describe: 'Path to the repository' });
}

function handleInstall(argv: RepoArgs & { force: boolean }): void {
  try {
    const result = installHooks({ repoPath: path.resolve(argv.repo), force: argv.force });
    success(`Commit gate installed in ${result.hooksDir}`);
    info(`pre-commit: ${result.preCommit}, post-commit: ${result.postCommit}`);
    info('Commits of unverified change batches will be blocked in agent worktrees.');
    info('Run `har env verify <agentId> --full` to validate a batch before committing.');
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

function handleUninstall(argv: RepoArgs): void {
  try {
    const result = uninstallHooks(path.resolve(argv.repo));
    if (result.removed) {
      success(`Commit gate removed from ${result.hooksDir}`);
    } else {
      info('No har hooks were installed.');
    }
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

function handleStatus(argv: RepoArgs & { json: boolean }): void {
  try {
    const status = getHooksStatus(path.resolve(argv.repo));
    if (argv.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return;
    }
    info(`Checkout:      ${status.checkout}`);
    info(`Hooks dir:     ${status.hooksDir}`);
    if (status.configuredHooksPath) {
      warn(`core.hooksPath is set (${status.configuredHooksPath}) — hooks are managed externally`);
    }
    info(`pre-commit:    ${status.preCommitInstalled ? 'installed' : 'not installed'}`);
    info(`post-commit:   ${status.postCommitInstalled ? 'installed' : 'not installed'}`);
    info(
      `Gate:          enabled=${status.gate.enabled} mode=${status.gate.mode} scope=${status.gate.scope}`,
    );
    info(`Effective:     ${status.effectiveMode} (in this checkout)`);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

function handleCheck(): void {
  const result = checkCommitGate(process.cwd());
  for (const message of result.messages) {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = result.exitCode;
}

async function handleRecordCommit(): Promise<void> {
  await recordCommitAssociation(process.cwd());
}

export const hooksCommand = {
  command: 'hooks <subcommand>',
  describe: 'Git commit gate: block commits of unverified change batches',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'install',
        'Install the pre-commit/post-commit gate into this repo (covers all worktrees)',
        (y: Argv) =>
          repoOption(y).option('force', {
            type: 'boolean',
            default: false,
            describe: 'Write hooks even when core.hooksPath points at a managed directory',
          }),
        handleInstall,
      )
      .command('uninstall', 'Remove the har commit gate hooks', repoOption, handleUninstall)
      .command(
        'status',
        'Show hook installation and gate configuration',
        (y: Argv) => repoOption(y).option('json', { type: 'boolean', default: false }),
        handleStatus,
      )
      .command(
        'check',
        'Pre-commit worker: verify the staged change batch (exit 1 = block)',
        () => {},
        handleCheck,
      )
      .command(
        'record-commit',
        'Post-commit worker: associate the new commit with its validation',
        () => {},
        handleRecordCommit,
      )
      .demandCommand(1, 'Specify a subcommand. Try: har hooks install'),
  handler: () => {},
};
