import * as readline from 'readline';
import { getHooksStatus, installHooks } from './hooks';
import { readStageRegistry, writeStageRegistry } from '../harness/stages';
import { info, warn } from '../utils/logging';

export interface CommitGateOnboardingOptions {
  repoPath: string;
  install: 'prompt' | 'always' | 'never';
  mode: 'block' | 'warn';
  scope: 'worktrees' | 'all';
  autoYes?: boolean;
}

function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    process.stderr.write(`${question} `);
    rl.once('line', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      resolve(trimmed === '' || /^y(es)?$/i.test(trimmed));
    });
  });
}

export async function handleCommitGateOnboarding(
  options: CommitGateOnboardingOptions,
): Promise<boolean> {
  const registry = readStageRegistry(options.repoPath);
  const gate = registry.commitGate;
  if (
    !gate ||
    gate.enabled !== true ||
    gate.mode !== options.mode ||
    gate.scope !== options.scope
  ) {
    writeStageRegistry(options.repoPath, {
      ...registry,
      commitGate: {
        enabled: true,
        mode: options.mode,
        scope: options.scope,
      },
    });
  }
  info(`Commit policy: mode=${options.mode} scope=${options.scope}`);

  if (options.install === 'never') {
    info('Skipped commit gate installation (user preference)');
    return false;
  }

  const status = getHooksStatus(options.repoPath);
  let shouldInstall =
    status.preCommitInstalled || status.postCommitInstalled || options.install === 'always' || options.autoYes === true;
  if (!shouldInstall && options.install === 'prompt' && process.stdin.isTTY && process.stdout.isTTY) {
    shouldInstall = await askYesNo('Install the HAR commit gate for this repository? [Y/n]');
  }
  if (!shouldInstall) {
    info('Commit gate is not installed; run `har hooks install` when ready.');
    return false;
  }

  try {
    installHooks({ repoPath: options.repoPath });
    info('Installed HAR pre-commit and post-commit hooks');
    return true;
  } catch (err) {
    warn(`Commit gate was not installed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
