import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import {
  applyPlugin,
  listPluginIds,
  readPluginManifest,
} from '../src/harness/plugins';
import { readStageRegistry } from '../src/harness/stages';

function makeTempRepo(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

describe('plugins', () => {
  it('applies playwright plugin to a scaffolded harness', () => {
    const repoPath = makeTempRepo('har-playwright');
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
    );

    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });

    const result = applyPlugin(repoPath, 'playwright', { skipCi: true });

    expect(result.pluginId).toBe('playwright');
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

  it('applies rocketsim plugin to a scaffolded harness', () => {
    const repoPath = makeTempRepo('har-rocketsim');
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'ios' });

    const result = applyPlugin(repoPath, 'rocketsim');

    expect(result.pluginId).toBe('rocketsim');
    expect(result.stageId).toBe('rocketsim-flows');
    expect(result.docsPath).toBe('.har/stages/ROCKETSIM.md');
    expect(result.nextSteps.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(repoPath, '.har', 'stages', 'rocketsim-flows.sh'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, 'flows', 'example-smoke.sh'))).toBe(true);

    const registry = readStageRegistry(repoPath);
    expect(registry.stages.find((s) => s.id === 'rocketsim-flows')).toMatchObject({
      id: 'rocketsim-flows',
      kind: 'test',
      script: 'stages/rocketsim-flows.sh',
    });
    expect(registry.verificationStages).toEqual(expect.arrayContaining(['rocketsim-flows']));

    const verify = registry.stages.find((s) => s.id === 'verify');
    expect(verify?.description).toContain('rocketsim-flows');
    expect(verify?.description).not.toContain('browser-e2e');
  });

  it('every shipped plugin manifest passes schema validation', () => {
    const ids = listPluginIds();
    expect(ids).toEqual(expect.arrayContaining(['playwright', 'rocketsim']));

    for (const id of ids) {
      const manifest = readPluginManifest(id);
      expect(manifest.nextSteps.length).toBeGreaterThan(0);
      expect(manifest.docsPath).toMatch(/^\.har\//);
      expect(manifest.files.map((f) => f.dest)).toContain(manifest.docsPath);
      expect(manifest.verificationStages).toContain(manifest.stageId);
    }
  });

  it('fails on second apply without force', () => {
    const repoPath = makeTempRepo('har-playwright-idempotent');
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
    );
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
    applyPlugin(repoPath, 'playwright', { skipCi: true });

    expect(() => applyPlugin(repoPath, 'playwright')).toThrow(/already/);
  });

  it('does not scaffold CLAUDE.md during boilerplate copy (installed via instruction-files)', () => {
    const repoPath = makeTempRepo('har-claude-md');
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'my-app', version: '1.0.0' }, null, 2) + '\n',
    );
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
    expect(fs.existsSync(path.join(repoPath, 'CLAUDE.md'))).toBe(false);
  });

  it('requires an existing harness', () => {
    const repoPath = makeTempRepo('har-no-harness');
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
    );

    expect(() => applyPlugin(repoPath, 'playwright')).toThrow(/har env init/);
  });

  it('CLI add-plugin applies playwright plugin', () => {
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
        'add-plugin',
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

  it('CLI add-stage <plugin> still works as deprecated alias', () => {
    const repoPath = makeTempRepo('har-playwright-cli-alias');
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
    );
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });

    const result = spawnSync(
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
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/deprecated/);
    expect(fs.existsSync(path.join(repoPath, '.har', 'stages', 'browser-e2e.sh'))).toBe(true);
  });
});
