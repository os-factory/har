import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { handleCommitGateOnboarding } from '../src/core/commit-gate-onboarding';
import { getHooksStatus } from '../src/core/hooks';
import { readStageRegistry } from '../src/harness/stages';

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-gate-onboarding-'));
  git(dir, ['init', '-q', '-b', 'main']);
  fs.mkdirSync(path.join(dir, '.har'));
  fs.writeFileSync(
    path.join(dir, '.har', 'stages.json'),
    `${JSON.stringify({ version: '1', stages: [] }, null, 2)}\n`,
  );
  return dir;
}

describe('commit gate onboarding', () => {
  it('persists visible policy without installing hooks when preference is never', async () => {
    const dir = initRepo();
    await handleCommitGateOnboarding({
      repoPath: dir,
      install: 'never',
      mode: 'warn',
      scope: 'all',
    });

    expect(readStageRegistry(dir).commitGate).toEqual({
      enabled: true,
      mode: 'warn',
      scope: 'all',
    });
    expect(getHooksStatus(dir).preCommitInstalled).toBe(false);
  });

  it('installs repository-wide hooks for always', async () => {
    const dir = initRepo();
    await handleCommitGateOnboarding({
      repoPath: dir,
      install: 'always',
      mode: 'block',
      scope: 'worktrees',
    });

    expect(getHooksStatus(dir).preCommitInstalled).toBe(true);
    expect(getHooksStatus(dir).postCommitInstalled).toBe(true);
  });
});
