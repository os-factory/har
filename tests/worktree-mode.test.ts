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
import { parseBoolean } from '../src/utils/parse-boolean';

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

    for (const off of ['false', 'off', '0', 'no']) {
      harnessEnv(off);
      expect(resolveWorktreeMode(repo)).toEqual({ enabled: false, source: 'harness-env' });
    }

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

  it('parseBoolean accepts the usual spellings and falls back otherwise', () => {
    for (const on of ['1', 'true', 'ON', ' yes ', 'enabled']) expect(parseBoolean(on)).toBe(true);
    for (const off of ['0', 'false', 'Off', 'no', 'disabled']) expect(parseBoolean(off)).toBe(false);
    expect(parseBoolean(undefined)).toBeUndefined();
    expect(parseBoolean('')).toBeUndefined();
    expect(parseBoolean('maybe', true)).toBe(true);
  });

  it('names the mode, who decided it and how to change it', () => {
    expect(describeWorktreeMode({ enabled: false, source: 'repo-preference' })).toBe(
      'Worktree: off (your setting for this repo; run `har worktree on` to change)',
    );
  });
});
