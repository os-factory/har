import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import {
  resolveAgentsScaffoldOptions,
  resolveCursorRuleFlag,
} from '../src/cli/commands/env';

function sh(cwd: string, command: string): string {
  return execFileSync('bash', ['-lc', command], {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function initFixtureRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-init-flags-'));
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email har@test.local');
  sh(dir, 'git config user.name har');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { typecheck: 'true', test: 'true' } }),
  );
  sh(dir, 'git add -A');
  sh(dir, 'git commit -q -m init');
  return dir;
}

function runInit(dir: string, extraArgs: string[]): { status: number | null; combined: string } {
  const cli = path.resolve(__dirname, '..', 'dist', 'index.js');
  const result = spawnSync(
    process.execPath,
    [cli, 'env', 'init', '--repo', dir, '--yes', '--profile', 'cli', ...extraArgs],
    {
      encoding: 'utf8',
      env: process.env,
    },
  );
  return {
    status: result.status,
    combined: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

describe('env init / maintain flag resolution', () => {
  it('maps --no-agents (yargs false) to enabled: false', () => {
    expect(resolveAgentsScaffoldOptions(false)).toEqual({ enabled: false });
    expect(resolveAgentsScaffoldOptions('claude,cursor')).toEqual({ agents: 'claude,cursor' });
    expect(resolveAgentsScaffoldOptions(undefined)).toEqual({});
  });

  it('maps --no-cursor-rule (yargs false) to skip', () => {
    expect(resolveCursorRuleFlag(false)).toBe(false);
    expect(resolveCursorRuleFlag(true)).toBe(true);
    expect(resolveCursorRuleFlag(undefined)).toBeUndefined();
  });
});

describe('har env init --no-agents / --no-cursor-rule (CLI)', () => {
  const cli = path.resolve(__dirname, '..', 'dist', 'index.js');
  const hasBuild = fs.existsSync(cli);
  const maybeIt = hasBuild ? it : it.skip;
  const fixtureDirs: string[] = [];

  afterEach(() => {
    for (const dir of fixtureDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  maybeIt('exits 0 and skips skills + cursor rule when both --no-* flags are set', () => {
    const dir = initFixtureRepo();
    fixtureDirs.push(dir);
    // Seed dirs so auto-detect would otherwise want to scaffold
    fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });

    const { status, combined } = runInit(dir, ['--no-agents', '--no-cursor-rule']);

    expect(status).toBe(0);
    expect(combined).toMatch(/Harness initialized/);
    expect(combined).not.toMatch(/raw\.split is not a function/);
    expect(fs.existsSync(path.join(dir, '.har', 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.har', '.gitignore'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.cursor', 'rules', 'har-workflow.mdc'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.claude', 'skills', 'setup-har', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.cursor', 'commands', 'setup-har.md'))).toBe(false);
  }, 20_000);

  maybeIt('still writes the cursor rule when --yes without --no-cursor-rule', () => {
    const dir = initFixtureRepo();
    fixtureDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });

    const { status, combined } = runInit(dir, ['--no-agents']);

    expect(status).toBe(0);
    expect(combined).not.toMatch(/raw\.split is not a function/);
    expect(fs.existsSync(path.join(dir, '.cursor', 'rules', 'har-workflow.mdc'))).toBe(true);
  }, 20_000);

  maybeIt('does not install auto-detected skills by default with --yes', () => {
    const dir = initFixtureRepo();
    fixtureDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });

    const { status } = runInit(dir, []);

    expect(status).toBe(0);
    expect(fs.existsSync(path.join(dir, '.cursor', 'rules', 'har-workflow.mdc'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.claude', 'skills', 'setup-har', 'SKILL.md'))).toBe(false);
    expect(fs.existsSync(path.join(dir, '.cursor', 'commands', 'setup-har.md'))).toBe(false);
  }, 20_000);
});
