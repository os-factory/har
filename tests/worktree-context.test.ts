import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectMissingWorktreeContext,
  formatWorktreeContextWarnings,
  type WorktreeContextFinding,
} from '../src/core/worktree-context';

const tmpDirs: string[] = [];

function git(cwd: string, args: string): void {
  execSync(
    `git -c user.email=har@example.com -c user.name=har -c commit.gpgsign=false ${args}`,
    { cwd, stdio: 'ignore' },
  );
}

function write(repo: string, relPath: string, contents = 'x\n'): void {
  const target = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

/** A git checkout with one tracked file so `HEAD` exists, plus the given files. */
function makeRepo(files: Record<string, string> = {}, tracked: string[] = []): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-worktree-context-'));
  tmpDirs.push(repo);
  git(repo, 'init -q');
  write(repo, 'tracked.txt');
  for (const [relPath, contents] of Object.entries(files)) {
    write(repo, relPath, contents);
  }
  git(repo, 'add tracked.txt' + (tracked.length ? ' ' + tracked.map((p) => `"${p}"`).join(' ') : ''));
  git(repo, 'commit -qm init');
  return repo;
}

function categoryPaths(
  findings: WorktreeContextFinding[],
  category: WorktreeContextFinding['category'],
): string[] {
  return findings.find((f) => f.category === category)?.paths ?? [];
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('detectMissingWorktreeContext', () => {
  it('returns nothing outside a git checkout', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'har-not-a-repo-')));
    tmpDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), '# rules\n');
    // Stop git walking upward: $TMPDIR itself may sit inside a checkout.
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = dir;
    try {
      expect(detectMissingWorktreeContext(dir)).toEqual([]);
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    }
  });

  it('flags instruction files hidden by a broad markdown ignore rule', () => {
    const repo = makeRepo(
      {
        '.gitignore': '*.md\n!README.md\n',
        'README.md': '# app\n',
        'CLAUDE.md': '# rules\n',
        'AGENTS.md': '# rules\n',
        'PRODUCT.md': '# spec\n',
      },
      ['.gitignore', 'README.md'],
    );
    const paths = categoryPaths(detectMissingWorktreeContext(repo), 'agent-context');
    expect(paths).toEqual(['AGENTS.md', 'CLAUDE.md', 'PRODUCT.md']);
  });

  it('collapses a fully untracked agent directory into one entry', () => {
    const repo = makeRepo({
      '.claude/skills/review/SKILL.md': '# skill\n',
      '.claude/settings.json': '{}\n',
    });
    expect(categoryPaths(detectMissingWorktreeContext(repo), 'agent-context')).toEqual(['.claude/']);
  });

  it('flags documentation directories and their markdown', () => {
    const repo = makeRepo({
      '.gitignore': '/docs/\n',
      'docs/design.md': '# design\n',
    });
    expect(categoryPaths(detectMissingWorktreeContext(repo), 'agent-context')).toEqual(['docs/']);
  });

  it('does not flag context files that are tracked', () => {
    const repo = makeRepo({ 'CLAUDE.md': '# rules\n' }, ['CLAUDE.md']);
    expect(detectMissingWorktreeContext(repo)).toEqual([]);
  });

  it('ignores dependency and build output', () => {
    const repo = makeRepo({
      '.gitignore': 'node_modules/\ndist/\nDerivedData/\nPods/\n',
      'node_modules/left-pad/readme.md': 'x\n',
      'dist/index.js': 'x\n',
      'DerivedData/Build/log.md': 'x\n',
      'Pods/Manifest.lock': 'x\n',
    });
    expect(detectMissingWorktreeContext(repo)).toEqual([]);
  });

  it('ignores files the harness generates itself', () => {
    const repo = makeRepo(
      {
        '.gitignore': '.env.agent.*\n.har/runs/\n',
        '.har/harness.env': 'export HARNESS_PROJECT_NAME=demo\n',
        '.env.agent.1': 'AGENT_ID=1\n',
        '.har/runs/2026-08-10/run.json': '{}\n',
      },
      ['.har/harness.env'],
    );
    expect(detectMissingWorktreeContext(repo)).toEqual([]);
  });

  it('ignores agent state that is machine-local by design', () => {
    const repo = makeRepo(
      {
        '.gitignore': '.claude/settings.local.json\n',
        '.claude/settings.json': '{}\n',
        '.claude/settings.local.json': '{}\n',
      },
      ['.gitignore', '.claude/settings.json'],
    );
    expect(detectMissingWorktreeContext(repo)).toEqual([]);
  });

  it('flags local build configuration separately from agent context', () => {
    const repo = makeRepo({
      '.gitignore': '*.xcconfig\n.env\n.env.agent.*\n',
      'Config/Secrets.xcconfig': 'API_KEY = abc\n',
      '.env': 'TOKEN=abc\n',
      '.env.agent.2': 'AGENT_ID=2\n',
    });
    const findings = detectMissingWorktreeContext(repo);
    expect(categoryPaths(findings, 'agent-context')).toEqual([]);
    expect(categoryPaths(findings, 'local-config')).toEqual(['.env', 'Config/Secrets.xcconfig']);
  });

  it('expands collapsed directories whose names carry spaces or glob characters', () => {
    const repo = makeRepo({
      '.gitignore': '*.xcconfig\n',
      'Supporting Files/Secrets.xcconfig': 'API_KEY = x\n',
      'assets[old]/.env.production': 'TOKEN=x\n',
    });
    expect(categoryPaths(detectMissingWorktreeContext(repo), 'local-config')).toEqual([
      'Supporting Files/Secrets.xcconfig',
      'assets[old]/.env.production',
    ]);
  });

  it('does not flag template placeholders as local config', () => {
    const repo = makeRepo({
      '.gitignore': '.env*\n',
      '.env.example': 'TOKEN=\n',
      '.env.production': 'TOKEN=real\n',
    });
    expect(categoryPaths(detectMissingWorktreeContext(repo), 'local-config')).toEqual([
      '.env.production',
    ]);
  });

  it('accepts project-declared context paths', () => {
    const repo = makeRepo({
      '.gitignore': '/handbook/\n',
      'handbook/onboarding.txt': 'rules\n',
    });
    const findings = detectMissingWorktreeContext(repo, { extraContext: ['handbook'] });
    expect(categoryPaths(findings, 'agent-context')).toEqual(['handbook/']);
  });

  it('reports the directories the expansion pass did not reach', () => {
    const files: Record<string, string> = { '.gitignore': '/data-*/\n' };
    for (let i = 0; i < 3; i++) files[`data-${i}/blob.bin`] = 'x\n';
    const findings = detectMissingWorktreeContext(makeRepo(files), {
      maxExpandedDirectories: 1,
    });
    expect(categoryPaths(findings, 'scan-limit')).toEqual(['data-1/', 'data-2/']);
  });

  it('drops paths covered by the ignore list', () => {
    const repo = makeRepo({
      '.gitignore': '*.md\n/docs/\n',
      'CLAUDE.md': '# rules\n',
      'docs/design.md': '# design\n',
    });
    const findings = detectMissingWorktreeContext(repo, { ignore: ['docs'] });
    expect(categoryPaths(findings, 'agent-context')).toEqual(['CLAUDE.md']);
  });

  it('caps the listed paths and counts the rest', () => {
    const files: Record<string, string> = { '.gitignore': '*.md\n' };
    for (let i = 0; i < 8; i++) files[`note-${i}.md`] = '# note\n';
    const findings = detectMissingWorktreeContext(makeRepo(files), { maxPathsPerCategory: 6 });
    expect(findings[0].paths).toHaveLength(6);
    expect(findings[0].omitted).toBe(2);
  });
});

describe('formatWorktreeContextWarnings', () => {
  it('names the paths and the consequence', () => {
    const [warning] = formatWorktreeContextWarnings([
      { category: 'agent-context', paths: ['CLAUDE.md', '.claude/'], omitted: 0 },
    ]);
    expect(warning).toContain('2 agent-context paths untracked');
    expect(warning).toContain('CLAUDE.md, .claude/');
    expect(warning).toContain('never read them');
    expect(warning).toContain('--no-worktree');
  });

  it('summarises the capped remainder and stays singular for one path', () => {
    const [warning] = formatWorktreeContextWarnings([
      { category: 'local-config', paths: ['.env'], omitted: 3 },
    ]);
    expect(warning).toContain('4 local-config paths untracked');
    expect(warning).toContain('(+3 more)');
    const single = formatWorktreeContextWarnings([
      { category: 'local-config', paths: ['.env'], omitted: 0 },
    ])[0];
    expect(single).toContain('1 local-config path untracked');
    expect(single).toContain('that need it');
  });
});
