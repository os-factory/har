import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  canonicalizeControlRepoPath,
  resolveMainWorkingTree,
} from '../src/core/control-repo-path';
import { recordRepoForControlSync, listRegisteredRepos } from '../src/core/control-registry';

function sh(cwd: string, command: string): string {
  return execSync(command, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-control-repo-'));
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email har@test.local');
  sh(dir, 'git config user.name har');
  fs.mkdirSync(path.join(dir, '.har'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.har', 'manifest.json'),
    JSON.stringify({
      version: '1',
      generatorVersion: '0.2.0',
      outputDir: '.har',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      stack: { language: 'node', packageManager: 'npm', database: 'none' },
    }),
  );
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  sh(dir, 'git add -A');
  sh(dir, 'git commit -q -m init');
  return dir;
}

function addWorktree(main: string): string {
  const worktree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'har-control-wt-')), 'wt');
  sh(main, `git worktree add -q "${worktree}" -b feature-har-agent-1-abcd`);
  return worktree;
}

describe('canonicalizeControlRepoPath', () => {
  afterEach(() => {
    delete process.env.HAR_CONTROL_REGISTRY_PATH;
    delete process.env.HAR_CONTROL_DISABLED;
  });

  it('leaves a main checkout path unchanged', () => {
    const main = initRepo();
    expect(canonicalizeControlRepoPath(main)).toBe(path.resolve(main));
    expect(resolveMainWorkingTree(main)).toBe(path.resolve(main));
  });

  it('maps a linked worktree root to the main checkout', () => {
    const main = initRepo();
    const worktree = addWorktree(main);
    expect(canonicalizeControlRepoPath(worktree)).toBe(path.resolve(main));
    expect(resolveMainWorkingTree(worktree)).toBe(path.resolve(main));
  });

  it('maps a path under a linked worktree to the same relative path on main', () => {
    const main = initRepo();
    fs.mkdirSync(path.join(main, 'control', '.har'), { recursive: true });
    fs.writeFileSync(
      path.join(main, 'control', '.har', 'manifest.json'),
      JSON.stringify({
        version: '1',
        generatorVersion: '0.2.0',
        outputDir: '.har',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        stack: { language: 'node', packageManager: 'npm', database: 'none' },
      }),
    );
    sh(main, 'git add -A');
    sh(main, 'git commit -q -m nested');

    const worktree = addWorktree(main);
    const nested = path.join(worktree, 'control');
    expect(canonicalizeControlRepoPath(nested)).toBe(path.resolve(main, 'control'));
  });

  it('returns the resolved path for non-git directories', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-nongit-'));
    expect(canonicalizeControlRepoPath(dir)).toBe(path.resolve(dir));
  });

  it('records the main checkout when given a worktree path', () => {
    const main = initRepo();
    const worktree = addWorktree(main);
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'har-control-registry-'));
    process.env.HAR_CONTROL_REGISTRY_PATH = path.join(tempHome, 'repos.json');

    recordRepoForControlSync(worktree);
    expect(listRegisteredRepos()).toEqual([path.resolve(main)]);
  });

  it('dedupes a worktree entry already stored in the registry', () => {
    const main = initRepo();
    const worktree = addWorktree(main);
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'har-control-registry-'));
    const registryPath = path.join(tempHome, 'repos.json');
    process.env.HAR_CONTROL_REGISTRY_PATH = registryPath;

    fs.writeFileSync(
      registryPath,
      JSON.stringify({ repos: [path.resolve(worktree), path.resolve(main)] }, null, 2),
    );

    expect(listRegisteredRepos()).toEqual([path.resolve(main)]);
    expect(JSON.parse(fs.readFileSync(registryPath, 'utf8')).repos).toEqual([
      path.resolve(main),
    ]);
  });
});
