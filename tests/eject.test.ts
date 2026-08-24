import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getHarPackageVersion } from '../src/core/package-version';
import { runDoctor } from '../src/harness/doctor';
import { compareHarnessToTemplate } from '../src/harness/drift';
import {
  adoptHarness,
  ejectHarness,
  EJECTED_RUNTIME_BUNDLE,
  EJECTED_RUNTIME_DIR,
} from '../src/harness/eject';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { readManifest } from '../src/harness/manifest';
import { RUNTIME_SHIM_FILES } from '../src/harness/template-tokens';

/**
 * #239 acceptance: ejecting is a deliberate, recorded, reversible choice.
 * Eject vendors the runtime into .har/runtime/, rewrites the scripts as
 * user-owned direct executors, and flips the manifest; drift treats owned
 * files as never-drifted; doctor validates the ejected runtime; adopt
 * restores managed shims while preserving the config surface.
 */
describe('har env eject / adopt (#239)', () => {
  let repo: string;
  let runtimeStub: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-eject-'));
    runtimeStub = path.join(repo, 'fake-dist-index.js');
    fs.writeFileSync(runtimeStub, '#!/usr/bin/env node\n// stub runtime bundle\n');
    process.env.HAR_EJECT_RUNTIME_SOURCE = runtimeStub;
    scaffoldHarnessBoilerplate(path.join(repo, 'proj'), { profile: 'default' });
  });

  afterEach(() => {
    delete process.env.HAR_EJECT_RUNTIME_SOURCE;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const proj = () => path.join(repo, 'proj');
  const har = (...p: string[]) => path.join(repo, 'proj', '.har', ...p);

  it('vendors the runtime, rewrites scripts, and records the choice in the manifest', () => {
    const result = ejectHarness(proj());

    expect(result.version).toBe(getHarPackageVersion());
    expect(fs.existsSync(har(EJECTED_RUNTIME_DIR, EJECTED_RUNTIME_BUNDLE))).toBe(true);
    expect(fs.existsSync(har(EJECTED_RUNTIME_DIR, 'README.md'))).toBe(true);

    expect(result.scripts.sort()).toEqual([...RUNTIME_SHIM_FILES].sort());
    for (const shim of RUNTIME_SHIM_FILES) {
      const content = fs.readFileSync(har(shim), 'utf8');
      expect(content).toContain(`runtime/${EJECTED_RUNTIME_BUNDLE}`);
      expect(content).toContain('EJECTED runtime');
      // Ownership means determinism: no PATH har, no npx network fallback.
      expect(content).not.toContain('exec har env');
      expect(content).not.toContain('npx');
      expect(fs.statSync(har(shim)).mode & 0o111).not.toBe(0);
    }
    // The delegate line keeps the managed shim's exact argument convention.
    expect(fs.readFileSync(har('verify.sh'), 'utf8')).toContain('env verify "$@" --json');
    expect(fs.readFileSync(har('launch.sh'), 'utf8')).toContain('env launch "$@"');
    expect(fs.readFileSync(har('agent-cli.sh'), 'utf8')).toContain('env agent "$@"');

    const manifest = readManifest(proj());
    expect(manifest?.ejected).toBe(true);
    expect(manifest?.ejectedVersion).toBe(getHarPackageVersion());
  });

  it('refuses to eject twice and to adopt a non-ejected harness', () => {
    expect(() => adoptHarness(proj())).toThrow(/not ejected/);
    ejectHarness(proj());
    expect(() => ejectHarness(proj())).toThrow(/already ejected/);
  });

  it('drift treats ejected scripts as user-owned — edits are never drift', () => {
    ejectHarness(proj());
    fs.appendFileSync(har('launch.sh'), '\n# my custom pre-launch tweak\n');

    const drift = compareHarnessToTemplate(proj());
    expect(drift.ownedByUser.sort()).toEqual([...RUNTIME_SHIM_FILES].sort());
    for (const shim of RUNTIME_SHIM_FILES) {
      expect(drift.userAdapted).not.toContain(shim);
      expect(drift.upstreamUpdated).not.toContain(shim);
      expect(drift.conflict).not.toContain(shim);
      expect(drift.missing).not.toContain(shim);
      expect(drift.unchanged).not.toContain(shim);
    }
  });

  it('a deleted ejected script still reports missing (broken harness, not ownership)', () => {
    ejectHarness(proj());
    fs.rmSync(har('teardown.sh'));
    const drift = compareHarnessToTemplate(proj());
    expect(drift.missing).toContain('teardown.sh');
    expect(drift.ownedByUser).not.toContain('teardown.sh');
  });

  it('non-ejected harness reports no owned files and doctor skips the check', () => {
    const drift = compareHarnessToTemplate(proj());
    expect(drift.ownedByUser).toEqual([]);
    // Fresh scaffold reports zero drift — rendered shims must be compared
    // against rendered templates (pinned __HAR_VERSION__), not raw ones.
    expect(drift.userAdapted).toEqual([]);
    expect(drift.upstreamUpdated).toEqual([]);
    expect(drift.conflict).toEqual([]);
    const report = runDoctor(proj());
    expect(report.checks.find((c) => c.id === 'ejected-runtime')?.status).toBe('skip');
  });

  it('doctor validates the ejected contract: green when intact, error on missing runtime', () => {
    ejectHarness(proj());
    let report = runDoctor(proj());
    expect(report.ok).toBe(true);
    expect(report.checks.find((c) => c.id === 'ejected-runtime')?.status).toBe('pass');

    fs.rmSync(har(EJECTED_RUNTIME_DIR, EJECTED_RUNTIME_BUNDLE));
    report = runDoctor(proj());
    expect(report.ok).toBe(false);
    expect(
      report.findings.some((f) => f.check === 'ejected-runtime' && f.severity === 'error'),
    ).toBe(true);
  });

  it('doctor warns on a non-executable ejected script', () => {
    ejectHarness(proj());
    fs.chmodSync(har('verify.sh'), 0o644);
    const report = runDoctor(proj());
    expect(
      report.findings.some(
        (f) => f.check === 'ejected-runtime' && f.severity === 'warning' && f.file === 'verify.sh',
      ),
    ).toBe(true);
  });

  it('adopt restores managed shims, removes the runtime, and preserves config files', () => {
    const envBefore = fs.readFileSync(har('harness.env'), 'utf8');
    const stagesBefore = fs.readFileSync(har('stages.json'), 'utf8');

    ejectHarness(proj());
    const result = adoptHarness(proj());

    expect(result.scripts.sort()).toEqual([...RUNTIME_SHIM_FILES].sort());
    expect(fs.existsSync(har(EJECTED_RUNTIME_DIR))).toBe(false);
    for (const shim of RUNTIME_SHIM_FILES) {
      const content = fs.readFileSync(har(shim), 'utf8');
      expect(content).toContain('exec har env');
      expect(content).toContain(`npx --yes @osfactory/har@${getHarPackageVersion()}`);
      expect(content).not.toContain('__HAR_VERSION__');
      expect(fs.statSync(har(shim)).mode & 0o111).not.toBe(0);
    }

    const manifest = readManifest(proj());
    expect(manifest?.ejected).toBeUndefined();
    expect(manifest?.ejectedVersion).toBeUndefined();
    expect(fs.readFileSync(har('harness.env'), 'utf8')).toBe(envBefore);
    expect(fs.readFileSync(har('stages.json'), 'utf8')).toBe(stagesBefore);

    const drift = compareHarnessToTemplate(proj());
    expect(drift.ownedByUser).toEqual([]);
    for (const shim of RUNTIME_SHIM_FILES) {
      expect(drift.userAdapted).not.toContain(shim);
      expect(drift.upstreamUpdated).not.toContain(shim);
      expect(drift.conflict).not.toContain(shim);
    }
  });
});
