import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyLine, readInstalledLineProgram } from '../src/harness/lines';
import { applyPlugin } from '../src/harness/plugins';
import { createLine } from '../src/harness/line-create';
import { readLineLedger } from '../src/harness/line-ledger';
import { listBundledLineIds } from '../src/harness/line-resolve';
import { cumulativeGateStages, getLineStatus, listInstalledLineIds } from '../src/core/lines';
import { runDoctor } from '../src/harness/doctor';
import { readStageRegistry } from '../src/harness/stages';
import { readManifest } from '../src/harness/manifest';
import { getHarPackageVersion } from '../src/core/package-version';

function makeTempRepo(name: string): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  fs.writeFileSync(
    path.join(repoPath, 'package.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
  );
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
  return repoPath;
}

describe('factory lines', () => {
  it('ships the example line as a bundled bundle', () => {
    expect(listBundledLineIds()).toContain('example-line');
  });

  it('applies a line without changing verificationStages', () => {
    const repoPath = makeTempRepo('har-line-apply');
    const before = readStageRegistry(repoPath);
    const verificationBefore = [...(before.verificationStages ?? [])];

    const result = applyLine(repoPath, 'example-line');

    expect(result.lineId).toBe('example-line');
    expect(result.stageIds).toEqual(['example-gate']);
    expect(result.stationIds).toEqual(['S1', 'S2', 'S3']);

    const after = readStageRegistry(repoPath);

    // The hard invariant (#304): apply may register stages, never widen verify.
    expect(after.verificationStages).toEqual(verificationBefore);
    expect(after.verificationStages ?? []).not.toContain('example-gate');

    // …and the stage really is registered.
    expect(after.stages.find((s) => s.id === 'example-gate')).toMatchObject({
      id: 'example-gate',
      kind: 'test',
      script: 'stages/example-gate.sh',
    });

    const stagePath = path.join(repoPath, '.har', 'stages', 'example-gate.sh');
    expect(fs.existsSync(stagePath)).toBe(true);
    expect(fs.statSync(stagePath).mode & 0o111).not.toBe(0);

    expect(fs.existsSync(path.join(repoPath, '.har', 'lines', 'example-line', 'line.json'))).toBe(
      true,
    );
    expect(
      fs.existsSync(path.join(repoPath, '.har', 'ADAPT-PROMPT-line-example-line.md')),
    ).toBe(true);
    expect(readManifest(repoPath)?.cliVersion).toBe(getHarPackageVersion());
  });

  it('records the install in .har/lines.json', () => {
    const repoPath = makeTempRepo('har-line-ledger');
    applyLine(repoPath, 'example-line');

    const ledger = readLineLedger(repoPath);
    expect(ledger?.lines).toHaveLength(1);
    expect(ledger?.lines[0]).toMatchObject({
      id: 'example-line',
      source: 'bundled',
      stageIds: ['example-gate'],
      programPath: '.har/lines/example-line/line.json',
    });
    expect(listInstalledLineIds(repoPath)).toEqual(['example-line']);
  });

  it('leaves the verify plan alone even next to an installed plugin', () => {
    const repoPath = makeTempRepo('har-line-with-plugin');
    applyPlugin(repoPath, 'playwright', { skipCi: true });
    const verificationBefore = [...(readStageRegistry(repoPath).verificationStages ?? [])];
    expect(verificationBefore).toContain('browser-e2e');

    applyLine(repoPath, 'example-line');

    expect(readStageRegistry(repoPath).verificationStages).toEqual(verificationBefore);
  });

  it('refuses a line bundle from add-plugin', () => {
    const repoPath = makeTempRepo('har-line-poka-plugin');
    const bundleDir = path.join(
      __dirname,
      '..',
      'src',
      'templates',
      'lines',
      'example-line',
    );
    // add-plugin resolves template.manifest.json; point it at the line bundle
    // via a copy that uses the plugin manifest name.
    const disguised = fs.mkdtempSync(path.join(os.tmpdir(), 'har-line-disguised-'));
    fs.cpSync(bundleDir, disguised, { recursive: true });
    fs.renameSync(
      path.join(disguised, 'line.manifest.json'),
      path.join(disguised, 'template.manifest.json'),
    );

    expect(() => applyPlugin(repoPath, disguised)).toThrow(/factory line bundle/i);
    expect(() => applyPlugin(repoPath, disguised)).toThrow(/har line add/);
  });

  it('refuses a verification plugin from line add', () => {
    const repoPath = makeTempRepo('har-line-poka-line');
    const pluginDir = path.join(__dirname, '..', 'src', 'templates', 'plugins', 'playwright');

    expect(() => applyLine(repoPath, pluginDir)).toThrow(/not a factory line bundle/i);
    expect(() => applyLine(repoPath, pluginDir)).toThrow(/har env add-plugin/);
  });

  it('scaffolds a project-owned line that installs unchanged', () => {
    const repoPath = makeTempRepo('har-line-create');
    const created = createLine(repoPath, { id: 'my-line', stations: ['A', 'B', 'C'] });

    expect(created.filesWritten).toEqual(
      expect.arrayContaining([
        '.har/lines/my-line/line.manifest.json',
        '.har/lines/my-line/line.json',
        '.har/lines/my-line/stages/my-line-gate.sh',
        '.har/lines/my-line/README.md',
      ]),
    );

    const verificationBefore = [...(readStageRegistry(repoPath).verificationStages ?? [])];
    const applied = applyLine(repoPath, 'my-line');

    expect(applied.source).toBe('local');
    expect(applied.stageIds).toEqual(['my-line-gate']);
    expect(readStageRegistry(repoPath).verificationStages).toEqual(verificationBefore);
    expect(readInstalledLineProgram(repoPath, 'my-line')?.stations.map((s) => s.id)).toEqual([
      'A',
      'B',
      'C',
    ]);
  });

  it('rejects a manifest that declares verificationStages', () => {
    const repoPath = makeTempRepo('har-line-reject-verify');
    const bundleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-line-bad-'));
    fs.cpSync(
      path.join(__dirname, '..', 'src', 'templates', 'lines', 'example-line'),
      bundleDir,
      { recursive: true },
    );
    const manifestPath = path.join(bundleDir, 'line.manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.verificationStages = ['example-gate'];
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    expect(() => applyLine(repoPath, bundleDir)).toThrow(/verificationStages/);
  });

  describe('the ratchet', () => {
    it('accumulates gate stages forward, never backward', () => {
      const repoPath = makeTempRepo('har-line-ratchet');
      applyLine(repoPath, 'example-line');
      const program = readInstalledLineProgram(repoPath, 'example-line');
      expect(program).not.toBeNull();

      expect(cumulativeGateStages(program!, 'S1').map((s) => s.id)).toEqual([]);
      expect(cumulativeGateStages(program!, 'S2').map((s) => s.id)).toEqual(['example-gate']);
      // Later stations keep every earlier station's stages.
      expect(cumulativeGateStages(program!, 'S3').map((s) => s.id)).toEqual(['example-gate']);
    });

    it('reports station progress with no green stations before any run', () => {
      const repoPath = makeTempRepo('har-line-status');
      applyLine(repoPath, 'example-line');

      const status = getLineStatus(repoPath, 'example-line');
      expect(status.lineId).toBe('example-line');
      expect(status.verifyLeaks).toEqual([]);
      expect(status.handoffAutonomousShip).toBe(false);

      // S1 has no gate stages, so it is trivially green; S2 is where work starts.
      expect(status.stations[0]).toMatchObject({ id: 'S1', green: true, requiredStageIds: [] });
      expect(status.stations[1]).toMatchObject({
        id: 'S2',
        green: false,
        requiredStageIds: ['example-gate'],
        neverRunStageIds: ['example-gate'],
      });
      expect(status.nextStationId).toBe('S2');
      expect(status.currentStationId).toBe('S1');
    });

    it('flags a line stage that leaked onto the verify plan', () => {
      const repoPath = makeTempRepo('har-line-leak');
      applyLine(repoPath, 'example-line');

      // Simulate a hand edit that puts the line stage on verify.
      const registryPath = path.join(repoPath, '.har', 'stages.json');
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      registry.verificationStages = [...(registry.verificationStages ?? []), 'example-gate'];
      fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

      const status = getLineStatus(repoPath, 'example-line');
      expect(status.verifyLeaks).toEqual(['example-gate']);
      expect(status.warnings.join(' ')).toMatch(/must stay off/);

      // doctor turns the same leak into a hard failure, so launch catches it.
      const report = runDoctor(repoPath);
      expect(report.ok).toBe(false);
      expect(report.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            check: 'factory-lines',
            severity: 'error',
            message: expect.stringContaining('example-gate'),
          }),
        ]),
      );
    });

    it('passes doctor on a correctly installed line', () => {
      const repoPath = makeTempRepo('har-line-doctor-ok');
      applyLine(repoPath, 'example-line');

      const report = runDoctor(repoPath);
      expect(report.findings.filter((f) => f.check === 'factory-lines')).toEqual([]);
      expect(report.checks.find((c) => c.id === 'factory-lines')?.status).toBe('pass');
    });
  });

  describe('CLI', () => {
    const cli = path.join(__dirname, '..', 'dist', 'index.js');

    it('installs a line and leaves the verify plan byte-identical', () => {
      const repoPath = makeTempRepo('har-line-cli');
      const registryPath = path.join(repoPath, '.har', 'stages.json');
      const before = JSON.parse(fs.readFileSync(registryPath, 'utf8')).verificationStages;

      execFileSync(process.execPath, [cli, 'line', 'add', 'example-line', '--repo', repoPath], {
        encoding: 'utf8',
      });

      const after = JSON.parse(fs.readFileSync(registryPath, 'utf8')).verificationStages;
      expect(after).toEqual(before);

      const status = JSON.parse(
        execFileSync(
          process.execPath,
          [cli, 'line', 'status', 'example-line', '--repo', repoPath, '--json'],
          { encoding: 'utf8' },
        ),
      );
      expect(status.lineId).toBe('example-line');
      expect(status.verifyLeaks).toEqual([]);
      expect(status.nextStationId).toBe('S2');
    });

    it('refuses the line bundle from env add-plugin', () => {
      const repoPath = makeTempRepo('har-line-cli-refuse');
      const bundleDir = path.join(__dirname, '..', 'src', 'templates', 'lines', 'example-line');

      const result = spawnSync(
        process.execPath,
        [cli, 'env', 'add-plugin', bundleDir, '--repo', repoPath],
        { encoding: 'utf8' },
      );

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/har line add/);
    });
  });
});
