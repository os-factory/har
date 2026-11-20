import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeWorktreePreference } from '../src/core/onboarding-preferences';
import {
  describeWorktreeMode,
  resolveWorktreeMode,
  worktreePreferenceKey,
} from '../src/core/worktree-mode';
import { LaunchEnvironmentInputSchema } from '../src/mcp/schemas';

describe('worktree mode', () => {
  let tmpDir: string;
  let repo: string;

  const harnessEnv = (value?: string) =>
    fs.writeFileSync(
      path.join(repo, '.har', 'harness.env'),
      value === undefined ? '' : `export HARNESS_USE_WORKTREE=${value}\n`,
    );

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-worktree-mode-'));
    repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repo, '.har'), { recursive: true });
    harnessEnv();
    process.env.HAR_PREFERENCES_PATH = path.join(tmpDir, 'preferences.json');
    delete process.env.HAR_WORKTREE;
  });

  afterEach(() => {
    delete process.env.HAR_PREFERENCES_PATH;
    delete process.env.HAR_WORKTREE;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resolves flag, HAR_WORKTREE, repo setting, global setting, harness.env, then on', () => {
    expect(resolveWorktreeMode(repo)).toEqual({ enabled: true, source: 'default' });

    harnessEnv('false');
    expect(resolveWorktreeMode(repo)).toEqual({ enabled: false, source: 'harness-env' });

    writeWorktreePreference('on');
    expect(resolveWorktreeMode(repo)).toEqual({ enabled: true, source: 'global-preference' });

    writeWorktreePreference('off', worktreePreferenceKey(repo));
    expect(resolveWorktreeMode(repo)).toEqual({ enabled: false, source: 'repo-preference' });

    process.env.HAR_WORKTREE = 'on';
    expect(resolveWorktreeMode(repo)).toEqual({ enabled: true, source: 'env' });

    expect(resolveWorktreeMode(repo, false)).toEqual({ enabled: false, source: 'flag' });
  });

  it('reset clears one scope and keeps the other', () => {
    const key = worktreePreferenceKey(repo);
    writeWorktreePreference('off');
    writeWorktreePreference('on', key);
    writeWorktreePreference(undefined, key);
    expect(resolveWorktreeMode(repo)).toEqual({ enabled: false, source: 'global-preference' });

    writeWorktreePreference('on', key);
    writeWorktreePreference(undefined);
    expect(resolveWorktreeMode(repo)).toEqual({ enabled: true, source: 'repo-preference' });
  });

  it('MCP launch input leaves an omitted worktree undecided', () => {
    // A schema default of true would shadow every setting below the flag.
    expect(LaunchEnvironmentInputSchema.parse({ agentId: 1 }).worktree).toBeUndefined();
    expect(LaunchEnvironmentInputSchema.parse({ agentId: 1, worktree: false }).worktree).toBe(false);
  });

  it('names the mode, who decided it and how to change it', () => {
    expect(describeWorktreeMode({ enabled: false, source: 'repo-preference' })).toBe(
      'Worktree: off (your setting for this repo; run `har worktree on` to change)',
    );
  });
});
