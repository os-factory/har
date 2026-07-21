import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { ensureRootGitignorePatterns, HARNESS_ROOT_GITIGNORE_PATTERNS } from '../src/core/gitignore';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { HARNESS_GITIGNORE_TEMPLATE, writeHarnessGitignore } from '../src/harness/gitignore-template';
import { resolveTemplatesDir } from '../src/utils/paths';

function sh(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-gitignore-'));
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email har@test.local');
  sh(dir, 'git config user.name har');
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  sh(dir, 'git add -A');
  sh(dir, 'git commit -q -m init');
  return dir;
}

describe('harness gitignore', () => {
  it('appends missing root gitignore patterns idempotently', () => {
    const dir = initRepo();

    ensureRootGitignorePatterns(dir);
    const first = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    for (const pattern of HARNESS_ROOT_GITIGNORE_PATTERNS) {
      expect(first).toContain(pattern);
    }

    ensureRootGitignorePatterns(dir);
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(first);
  });

  it('scaffolds root gitignore patterns for agent slot artifacts', () => {
    const dir = initRepo();
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { typecheck: 'true', test: 'true' } }),
    );

    scaffoldHarnessBoilerplate(dir, { force: true, profile: 'cli' });

    const gitignore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8');
    for (const pattern of HARNESS_ROOT_GITIGNORE_PATTERNS) {
      expect(gitignore).toContain(pattern);
    }

    const harGitignore = fs.readFileSync(path.join(dir, '.har', '.gitignore'), 'utf8');
    expect(harGitignore).toContain('.env.agent.*');
    expect(harGitignore).toContain('ecosystem.agent.*.config.cjs');
  });

  it('ships gitignore.template in all boilerplate profiles (npm strips .gitignore)', () => {
    const templatesDir = resolveTemplatesDir();
    for (const profile of ['har-boilerplate', 'har-boilerplate-cli', 'har-boilerplate-ios']) {
      expect(fs.existsSync(path.join(templatesDir, profile, HARNESS_GITIGNORE_TEMPLATE))).toBe(true);
      expect(fs.existsSync(path.join(templatesDir, profile, '.gitignore'))).toBe(false);
    }
  });

  it('writes .har/.gitignore from gitignore.template when npm omits .gitignore', () => {
    const dir = initRepo();
    const templatesDir = resolveTemplatesDir();
    const boilerplateDir = path.join(templatesDir, 'har-boilerplate-cli');
    const harnessDir = path.join(dir, '.har');

    fs.mkdirSync(harnessDir, { recursive: true });
    writeHarnessGitignore(harnessDir, boilerplateDir);

    const harGitignore = fs.readFileSync(path.join(harnessDir, '.gitignore'), 'utf8');
    expect(harGitignore).toContain('runs/');
    expect(harGitignore).toContain('validations/');
  });
});
