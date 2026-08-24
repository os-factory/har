import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { createLocalPlugin } from '../src/harness/plugin-create';
import { applyPlugin, PluginManifestSchema } from '../src/harness/plugins';
import { listLocalPluginIds, resolvePluginSource } from '../src/harness/plugin-resolve';
import { readPluginLedger } from '../src/harness/plugin-ledger';
import {
  buildPluginDriftActions,
  compareInstalledPluginsToTemplate,
  comparePluginToTemplate,
  detectInstalledPlugins,
} from '../src/harness/plugin-drift';
import { readStageRegistry } from '../src/harness/stages';

function makeTempRepo(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function scaffoldRepo(name: string): string {
  const repoPath = makeTempRepo(name);
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
  return repoPath;
}

describe('har plugin create (local plugins)', () => {
  it('scaffolds a complete local plugin with a schema-valid manifest', () => {
    const repoPath = scaffoldRepo('har-plugin-create');

    const result = createLocalPlugin(repoPath, {
      id: 'db-integrity',
      description: 'Check DB invariants',
    });

    expect(result.pluginId).toBe('db-integrity');
    const pluginDir = path.join(repoPath, '.har', 'plugins', 'db-integrity');
    expect(result.pluginDir).toBe(pluginDir);
    expect(result.filesWritten).toEqual(
      expect.arrayContaining([
        '.har/plugins/db-integrity/template.manifest.json',
        '.har/plugins/db-integrity/stages/db-integrity.sh',
        '.har/plugins/db-integrity/README.md',
      ]),
    );

    const manifestRaw = JSON.parse(
      fs.readFileSync(path.join(pluginDir, 'template.manifest.json'), 'utf8'),
    ) as unknown;
    const parsed = PluginManifestSchema.safeParse(manifestRaw);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.id).toBe('db-integrity');
      expect(parsed.data.verificationStages).toEqual(['db-integrity']);
      expect(parsed.data.docsPath).toBe('.har/plugins/db-integrity/README.md');
    }

    const script = path.join(pluginDir, 'stages', 'db-integrity.sh');
    expect((fs.statSync(script).mode & 0o111) !== 0).toBe(true);
    const scriptContent = fs.readFileSync(script, 'utf8');
    expect(scriptContent).toContain('db-integrity');
    expect(scriptContent).not.toContain('__STAGE_ID__');

    const readme = fs.readFileSync(path.join(pluginDir, 'README.md'), 'utf8');
    expect(readme).toContain('db-integrity');
    expect(readme).not.toContain('__PLUGIN_ID__');
    // Publishing path is documented in the scaffold
    expect(readme).toMatch(/npm publish/);
    expect(readme).toMatch(/git/);

    expect(listLocalPluginIds(repoPath)).toEqual(['db-integrity']);
  });

  it('scaffolds package.fragment.json when requested', () => {
    const repoPath = scaffoldRepo('har-plugin-create-frag');
    createLocalPlugin(repoPath, { id: 'with-frag', packageFragment: true });

    const pluginDir = path.join(repoPath, '.har', 'plugins', 'with-frag');
    expect(fs.existsSync(path.join(pluginDir, 'package.fragment.json'))).toBe(true);
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginDir, 'template.manifest.json'), 'utf8'),
    ) as { merge?: Record<string, string> };
    expect(manifest.merge).toEqual({ 'package.json': 'package.fragment.json' });
  });

  it('rejects invalid ids, missing harness, and existing dirs without --force', () => {
    const repoPath = scaffoldRepo('har-plugin-create-guards');
    expect(() => createLocalPlugin(repoPath, { id: 'Bad Id' })).toThrow(/Invalid plugin id/);
    expect(() => createLocalPlugin(repoPath, { id: 'x', kind: 'nope' as never })).toThrow(
      /Invalid stage kind/,
    );

    createLocalPlugin(repoPath, { id: 'dup' });
    expect(() => createLocalPlugin(repoPath, { id: 'dup' })).toThrow(/--force/);
    expect(() => createLocalPlugin(repoPath, { id: 'dup', force: true })).not.toThrow();

    const bare = makeTempRepo('har-plugin-create-noharness');
    expect(() => createLocalPlugin(bare, { id: 'x' })).toThrow(/har env init/);
  });

  it('resolves and installs a local plugin by bare id with ledger source "local"', () => {
    const repoPath = scaffoldRepo('har-plugin-local-install');
    createLocalPlugin(repoPath, { id: 'db-integrity' });

    const source = resolvePluginSource('db-integrity', repoPath);
    expect(source.kind).toBe('local');

    const result = applyPlugin(repoPath, 'db-integrity');
    expect(result.source).toBe('local');
    expect(result.stageIds).toEqual(['db-integrity']);
    expect(fs.existsSync(path.join(repoPath, '.har', 'stages', 'db-integrity.sh'))).toBe(true);

    const registry = readStageRegistry(repoPath);
    expect(registry.stages.find((s) => s.id === 'db-integrity')).toMatchObject({
      id: 'db-integrity',
      script: 'stages/db-integrity.sh',
    });
    expect(registry.verificationStages).toEqual(expect.arrayContaining(['db-integrity']));

    const ledger = readPluginLedger(repoPath);
    const entry = ledger?.plugins.find((p) => p.id === 'db-integrity');
    expect(entry?.source).toBe('local');
  });

  it('resolves a path spec under .har/plugins/ as local', () => {
    const repoPath = scaffoldRepo('har-plugin-local-path');
    createLocalPlugin(repoPath, { id: 'by-path' });
    const source = resolvePluginSource(
      path.join(repoPath, '.har', 'plugins', 'by-path'),
      repoPath,
    );
    expect(source.kind).toBe('local');
    expect(source.id).toBe('by-path');
  });

  it('covers local plugin files with drift against the project-owned baseline', () => {
    const repoPath = scaffoldRepo('har-plugin-local-drift');
    createLocalPlugin(repoPath, { id: 'db-integrity' });
    applyPlugin(repoPath, 'db-integrity');

    expect(detectInstalledPlugins(repoPath)).toContain('db-integrity');

    const clean = comparePluginToTemplate(repoPath, 'db-integrity');
    expect(clean.baseline).toBe('local');
    expect(clean.checksumMismatch).toEqual([]);
    expect(clean.missing).toEqual([]);
    expect(clean.unchanged).toContain('.har/stages/db-integrity.sh');

    fs.appendFileSync(path.join(repoPath, '.har', 'stages', 'db-integrity.sh'), '\n# edited\n');
    const drifted = compareInstalledPluginsToTemplate(repoPath).find(
      (d) => d.pluginId === 'db-integrity',
    );
    expect(drifted?.checksumMismatch).toContain('.har/stages/db-integrity.sh');

    const actions = buildPluginDriftActions(repoPath, [drifted!]);
    expect(actions[0].hint).toContain('.har/plugins/db-integrity');
  });
});

describe('add-stage --custom removal', () => {
  it('CLI add-stage --custom fails with a pointer to har plugin create', () => {
    const repoPath = scaffoldRepo('har-add-stage-removed');
    const result = spawnSync(
      process.execPath,
      [
        path.join(__dirname, '..', 'dist', 'index.js'),
        'env',
        'add-stage',
        'my-check',
        '--custom',
        '--repo',
        repoPath,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/removed in 1\.0/);
    expect(result.stderr).toMatch(/har plugin create my-check/);
  });

  it('CLI har plugin create scaffolds end-to-end', () => {
    const repoPath = scaffoldRepo('har-plugin-create-cli');
    const result = spawnSync(
      process.execPath,
      [
        path.join(__dirname, '..', 'dist', 'index.js'),
        'plugin',
        'create',
        'cli-made',
        '--repo',
        repoPath,
      ],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(
      fs.existsSync(path.join(repoPath, '.har', 'plugins', 'cli-made', 'template.manifest.json')),
    ).toBe(true);
    expect(result.stderr).toMatch(/har env add-plugin cli-made/);
  });
});
