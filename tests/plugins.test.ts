import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import {
  applyPlugin,
  listPluginIds,
  primaryStageId,
  readPluginManifest,
} from '../src/harness/plugins';
import { readPluginLedger } from '../src/harness/plugin-ledger';
import { readProfileManifest } from '../src/harness/profiles';
import {
  harnessAllocatesAppPorts,
  harnessUsesPm2,
  harnessUsesSimulator,
} from '../src/harness/capabilities';
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

  it('applies kerno plugin to a scaffolded harness', () => {
    const repoPath = makeTempRepo('har-kerno');
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'default' });

    const result = applyPlugin(repoPath, 'kerno');

    expect(result.pluginId).toBe('kerno');
    expect(result.stageId).toBe('backend-validation');
    expect(result.docsPath).toBe('.har/stages/KERNO.md');
    expect(result.nextSteps.length).toBeGreaterThan(0);

    const stageScript = path.join(repoPath, '.har', 'stages', 'backend-validation.sh');
    expect(fs.existsSync(stageScript)).toBe(true);
    // Stage script is copied with the executable bit set.
    expect((fs.statSync(stageScript).mode & 0o111) !== 0).toBe(true);
    expect(fs.existsSync(path.join(repoPath, '.har', 'stages', 'KERNO.md'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, 'tests', 'kerno', 'README.md'))).toBe(true);

    const registry = readStageRegistry(repoPath);
    expect(registry.stages.find((s) => s.id === 'backend-validation')).toMatchObject({
      id: 'backend-validation',
      kind: 'test',
      script: 'stages/backend-validation.sh',
    });
    expect(registry.verificationStages).toEqual(expect.arrayContaining(['backend-validation']));

    const verify = registry.stages.find((s) => s.id === 'verify');
    expect(verify?.description).toContain('backend-validation');
  });

  it('applies gitleaks plugin to a scaffolded harness', () => {
    const repoPath = makeTempRepo('har-gitleaks');
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });

    const result = applyPlugin(repoPath, 'gitleaks', { skipCi: true });

    expect(result.pluginId).toBe('gitleaks');
    expect(result.stageId).toBe('secrets-scan');
    expect(result.docsPath).toBe('.har/stages/GITLEAKS.md');
    expect(result.nextSteps.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(repoPath, '.har', 'stages', 'secrets-scan.sh'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, '.har', 'stages', 'GITLEAKS.md'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, '.gitleaks.toml'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, '.github', 'workflows', 'gitleaks.yml'))).toBe(false);

    const stat = fs.statSync(path.join(repoPath, '.har', 'stages', 'secrets-scan.sh'));
    expect(stat.mode & 0o111).not.toBe(0);

    const registry = readStageRegistry(repoPath);
    expect(registry.stages.find((s) => s.id === 'secrets-scan')).toMatchObject({
      id: 'secrets-scan',
      kind: 'test',
      script: 'stages/secrets-scan.sh',
    });
    expect(registry.verificationStages).toEqual(expect.arrayContaining(['secrets-scan']));

    const verify = registry.stages.find((s) => s.id === 'verify');
    expect(verify?.description).toContain('secrets-scan');
  });

  it('applies trivy plugin to a scaffolded harness', () => {
    const repoPath = makeTempRepo('har-trivy');
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });

    const result = applyPlugin(repoPath, 'trivy', { skipCi: true });

    expect(result.pluginId).toBe('trivy');
    expect(result.stageId).toBe('vuln-scan');
    expect(result.docsPath).toBe('.har/stages/TRIVY.md');
    expect(result.nextSteps.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(repoPath, '.har', 'stages', 'vuln-scan.sh'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, '.trivyignore'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, '.github', 'workflows', 'trivy.yml'))).toBe(false);

    const stat = fs.statSync(path.join(repoPath, '.har', 'stages', 'vuln-scan.sh'));
    expect(stat.mode & 0o111).not.toBe(0);

    const registry = readStageRegistry(repoPath);
    expect(registry.stages.find((s) => s.id === 'vuln-scan')).toMatchObject({
      id: 'vuln-scan',
      kind: 'test',
      script: 'stages/vuln-scan.sh',
    });
    expect(registry.verificationStages).toEqual(expect.arrayContaining(['vuln-scan']));

    const verify = registry.stages.find((s) => s.id === 'verify');
    expect(verify?.description).toContain('vuln-scan');
  });

  it('applies semgrep plugin to a scaffolded harness', () => {
    const repoPath = makeTempRepo('har-semgrep');
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });

    const result = applyPlugin(repoPath, 'semgrep', { skipCi: true });

    expect(result.pluginId).toBe('semgrep');
    expect(result.stageId).toBe('sast');
    expect(result.docsPath).toBe('.har/stages/SEMGREP.md');
    expect(result.nextSteps.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(repoPath, '.har', 'stages', 'sast.sh'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, '.har', 'stages', 'SEMGREP.md'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, '.github', 'workflows', 'semgrep.yml'))).toBe(false);

    const stat = fs.statSync(path.join(repoPath, '.har', 'stages', 'sast.sh'));
    expect(stat.mode & 0o111).not.toBe(0);

    const registry = readStageRegistry(repoPath);
    expect(registry.stages.find((s) => s.id === 'sast')).toMatchObject({
      id: 'sast',
      kind: 'test',
      script: 'stages/sast.sh',
    });
    expect(registry.verificationStages).toEqual(expect.arrayContaining(['sast']));

    const verify = registry.stages.find((s) => s.id === 'verify');
    expect(verify?.description).toContain('sast');
  });

  it('every shipped plugin manifest passes schema validation', () => {
    const ids = listPluginIds();
    expect(ids).toEqual(expect.arrayContaining(['playwright', 'rocketsim', 'kerno', 'gitleaks', 'trivy', 'semgrep']));

    for (const id of ids) {
      const manifest = readPluginManifest(id);
      expect(manifest.nextSteps.length).toBeGreaterThan(0);
      expect(manifest.docsPath).toMatch(/^\.har\//);
      expect(manifest.files.map((f) => f.dest)).toContain(manifest.docsPath);
      expect(manifest.verificationStages).toContain(primaryStageId(manifest));
    }
  });

  it('writes .har/plugins.json ledger on apply', () => {
    const repoPath = makeTempRepo('har-plugin-ledger');
    fs.writeFileSync(
      path.join(repoPath, 'package.json'),
      JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
    );
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
    applyPlugin(repoPath, 'gitleaks', { skipCi: true });

    const ledger = readPluginLedger(repoPath);
    expect(ledger?.profile).toBe('cli');
    expect(ledger?.bundles).toEqual(expect.arrayContaining(['shared-kernel', 'runtime-cli']));
    expect(ledger?.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'gitleaks',
          source: 'bundled',
          stageIds: ['secrets-scan'],
        }),
      ]),
    );
  });

  it('applies a multi-stage plugin from a local path', () => {
    const pluginDir = makeTempRepo('har-multi-plugin-src');
    fs.writeFileSync(
      path.join(pluginDir, 'template.manifest.json'),
      JSON.stringify(
        {
          id: 'dual-check',
          verificationStages: ['check-a', 'check-b'],
          stages: [
            {
              id: 'check-a',
              kind: 'test',
              description: 'Check A',
              script: 'stages/check-a.sh',
              requiresAgentId: true,
            },
            {
              id: 'check-b',
              kind: 'test',
              description: 'Check B',
              script: 'stages/check-b.sh',
              requiresAgentId: true,
            },
          ],
          files: [
            { src: 'stages/check-a.sh', dest: '.har/stages/check-a.sh', executable: true },
            { src: 'stages/check-b.sh', dest: '.har/stages/check-b.sh', executable: true },
            { src: 'stages/DUAL.md', dest: '.har/stages/DUAL.md' },
          ],
          nextSteps: ['./.har/stages/check-a.sh 1'],
          docsPath: '.har/stages/DUAL.md',
        },
        null,
        2,
      ) + '\n',
    );
    fs.mkdirSync(path.join(pluginDir, 'stages'));
    for (const name of ['check-a.sh', 'check-b.sh']) {
      fs.writeFileSync(
        path.join(pluginDir, 'stages', name),
        '#!/usr/bin/env bash\necho "{}"\n',
      );
    }
    fs.writeFileSync(path.join(pluginDir, 'stages', 'DUAL.md'), '# Dual\n');

    const repoPath = makeTempRepo('har-multi-plugin-dst');
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });

    const result = applyPlugin(repoPath, pluginDir, { spec: pluginDir });
    expect(result.pluginId).toBe('dual-check');
    expect(result.source).toBe('path');
    expect(result.stageIds).toEqual(['check-a', 'check-b']);
    expect(fs.existsSync(path.join(repoPath, '.har', 'stages', 'check-a.sh'))).toBe(true);
    expect(fs.existsSync(path.join(repoPath, '.har', 'stages', 'check-b.sh'))).toBe(true);

    const registry = readStageRegistry(repoPath);
    expect(registry.stages.some((s) => s.id === 'check-a')).toBe(true);
    expect(registry.stages.some((s) => s.id === 'check-b')).toBe(true);
    expect(registry.verificationStages).toEqual(
      expect.arrayContaining(['check-a', 'check-b']),
    );

    const ledger = readPluginLedger(repoPath);
    expect(ledger?.plugins.some((p) => p.id === 'dual-check' && p.source === 'path')).toBe(true);
  });

  it('composes profiles from ordered runtime bundles', () => {
    expect(readProfileManifest('default').bundles.map((b) => b.id)).toEqual([
      'shared-kernel',
      'pm2-runtime',
      'runtime-default',
    ]);
    expect(readProfileManifest('cli').bundles.map((b) => b.id)).toEqual([
      'shared-kernel',
      'runtime-cli',
    ]);
    expect(readProfileManifest('ios').bundles.map((b) => b.id)).toEqual([
      'shared-kernel',
      'xcode-sim',
      'runtime-ios',
    ]);

    const web = makeTempRepo('har-cap-web');
    scaffoldHarnessBoilerplate(web, { force: true, profile: 'default' });
    expect(harnessUsesPm2(web)).toBe(true);
    expect(harnessAllocatesAppPorts(web)).toBe(true);
    expect(harnessUsesSimulator(web)).toBe(false);
    expect(readPluginLedger(web)?.bundles).toEqual([
      'shared-kernel',
      'pm2-runtime',
      'runtime-default',
    ]);

    const cli = makeTempRepo('har-cap-cli');
    scaffoldHarnessBoilerplate(cli, { force: true, profile: 'cli' });
    expect(harnessUsesPm2(cli)).toBe(false);
    expect(fs.existsSync(path.join(cli, '.har', 'ecosystem.agent.template.cjs'))).toBe(false);

    const ios = makeTempRepo('har-cap-ios');
    scaffoldHarnessBoilerplate(ios, { force: true, profile: 'ios' });
    expect(harnessUsesSimulator(ios)).toBe(true);
    expect(harnessUsesPm2(ios)).toBe(false);
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
