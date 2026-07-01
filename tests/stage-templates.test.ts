import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyStageTemplate } from '../src/harness/stage-templates';
import { readStageRegistry } from '../src/harness/stages';

function makeTempRepo(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

describe('stage templates', () => {
  it('applies playwright template to a scaffolded harness', () => {
    const repoPath = makeTempRepo('har-playwright');
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
    );

    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });

    const result = applyStageTemplate(repoPath, 'playwright', { skipCi: true });

    expect(result.stageId).toBe('browser-e2e');
    expect(fs.existsSync(path.join(repoPath, '.har', 'stages', 'browser-e2e.sh'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, 'playwright.config.js'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, 'tests', 'frontend', 'smoke.spec.js'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, 'tests', 'api', 'health.spec.js'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, 'tests', 'a11y', 'smoke.spec.js'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, '.github', 'workflows', 'playwright.yml'))).toBe(false);

    const stat = fs.statSync(path.join(repoPath, '.har', 'stages', 'browser-e2e.sh'));
    expect(stat.mode & 0o111).not.toBe(0);

    const registry = readStageRegistry(repoPath);
    expect(registry.stages.find((s) => s.id === 'browser-e2e')).toMatchObject({
      id: 'browser-e2e',
      kind: 'test',
      script: 'stages/browser-e2e.sh',
    });
    expect(registry.verificationStages).toEqual(
      expect.arrayContaining(['typecheck', 'unit-tests', 'api-health', 'lint', 'browser-e2e']),
    );

    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.scripts['test:e2e']).toBe('playwright test');
    expect(pkg.devDependencies['@playwright/test']).toBe('^1.40.0');
  });

  it('fails on second apply without force', () => {
    const repoPath = makeTempRepo('har-playwright-idempotent');
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
    );
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
    applyStageTemplate(repoPath, 'playwright', { skipCi: true });

    expect(() => applyStageTemplate(repoPath, 'playwright')).toThrow(/already/);
  });

  it('scaffolds CLAUDE.md on init when missing', () => {
    const repoPath = makeTempRepo('har-claude-md');
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'my-app', version: '1.0.0' }, null, 2) + '\n',
    );
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
    expect(fs.existsSync(path.join(repoPath, 'CLAUDE.md'))).toBe(true);
    expect(fs.readFileSync(path.join(repoPath, 'CLAUDE.md'), 'utf8')).toContain('.har/README.md');
  });

  it('requires an existing harness', () => {
    const repoPath = makeTempRepo('har-no-harness');
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
    );

    expect(() => applyStageTemplate(repoPath, 'playwright')).toThrow(/har env init/);
  });

  it('CLI add-stage applies playwright template', () => {
    const repoPath = makeTempRepo('har-playwright-cli');
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
    );
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });

    execFileSync(
      process.execPath,
      [
        path.join(__dirname, '..', 'dist', 'index.js'),
        'env',
        'add-stage',
        'playwright',
        '--repo',
        repoPath,
        '--skip-ci',
      ],
      { encoding: 'utf8', stdio: 'pipe' },
    );

    expect(fs.existsSync(path.join(repoPath, '.har', 'stages', 'browser-e2e.sh'))).toBe(true);
    const registry = readStageRegistry(repoPath);
    expect(registry.stages.some((s) => s.id === 'browser-e2e')).toBe(true);
  });
});
