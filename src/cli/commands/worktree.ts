import * as path from 'path';
import type { Argv } from 'yargs';
import {
  getOnboardingPreferencesPath,
  writeWorktreePreference,
} from '../../core/onboarding-preferences';
import {
  describeWorktreeMode,
  resolveWorktreeMode,
  worktreePreferenceKey,
} from '../../core/worktree-mode';
import { info, success } from '../../utils/logging';

interface ScopeArgv {
  repo: string;
  global: boolean;
}

function handleStatus(argv: { repo: string; json: boolean }): void {
  const repo = path.resolve(argv.repo);
  const mode = resolveWorktreeMode(repo);
  if (argv.json) {
    process.stdout.write(`${JSON.stringify({ ...mode, repo: worktreePreferenceKey(repo) }, null, 2)}\n`);
    return;
  }
  info(describeWorktreeMode(mode));
  info(`Preference: ${getOnboardingPreferencesPath()}`);
}

function handleSet(mode: 'on' | 'off' | undefined, argv: ScopeArgv): void {
  const repo = path.resolve(argv.repo);
  writeWorktreePreference(mode, argv.global ? undefined : worktreePreferenceKey(repo));
  const scope = argv.global ? 'all repos' : worktreePreferenceKey(repo);
  success(mode ? `Session worktrees ${mode} for ${scope}` : `Cleared your worktree setting for ${scope}`);
  // A higher-precedence source (HAR_WORKTREE, a per-repo setting) may still win.
  info(describeWorktreeMode(resolveWorktreeMode(repo)));
}

const setCommand = (name: 'on' | 'off' | 'reset', describe: string) => ({
  command: name,
  describe,
  builder: (y: Argv) =>
    y
      .option('repo', { type: 'string', default: '.', describe: 'Repository the setting applies to' })
      .option('global', { type: 'boolean', default: false, describe: 'Apply to all repositories' }),
  handler: (argv: ScopeArgv) => handleSet(name === 'reset' ? undefined : name, argv),
});

export const worktreeCommand = {
  command: 'worktree <subcommand>',
  describe: 'Your personal default: launch slots in a session worktree, or in the checkout itself',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'status',
        'Show whether a launch uses a session worktree, and which setting decided it',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', default: '.' })
            .option('json', { type: 'boolean', default: false }),
        (argv) => handleStatus(argv as unknown as { repo: string; json: boolean }),
      )
      .command(setCommand('on', 'Launch slots in a session worktree'))
      .command(setCommand('off', 'Launch slots in the checkout itself (no worktree, no session branch)'))
      .command(setCommand('reset', 'Clear your setting and fall back to the repo default'))
      .demandCommand(1, 'Specify a subcommand: status, on, off or reset'),
  handler: () => {},
};
