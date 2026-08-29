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
import { MANAGED_SHIM_FILES } from '../src/harness/template-tokens';

/**
 * #239 / #314: eject vendors .har/runtime/ and does not write wrapper scripts.
 * Invocation is `har env …` or `node .har/runtime/har.cjs env …`.
 */
describe('har env eject / adopt (#239 / #314)', () => {
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

  it('vendors the runtime and records the choice without writing wrappers', () => {
    const result = ejectHarness(proj());

    expect(result.version).toBe(getHarPackageVersion());
    expect(fs.existsSync(har(EJECTED_RUNTIME_DIR, EJECTED_RUNTIME_BUNDLE))).toBe(true);
    expect(fs.existsSync(har(EJECTED_RUNTIME_DIR, 'README.md'))).toBe(true);
    expect(result.scripts).toEqual([]);
    for (const shim of MANAGED_SHIM_FILES) {
      expect(fs.existsSync(har(shim))).toBe(false);
    }

    const manifest = readManifest(proj());
    expect(manifest?.ejected).toBe(true);
    expect(manifest?.ejectedVersion).toBe(getHarPackageVersion());
  });

  it('refuses to eject twice and to adopt a non-ejected harness', () => {
    expect(() => adoptHarness(proj())).toThrow(/not ejected/);
    ejectHarness(proj());
    expect(() => ejectHarness(proj())).toThrow(/already ejected/);
  });

  it('drift does not treat missing wrappers as missing template files', () => {
    ejectHarness(proj());
    const drift = compareHarnessToTemplate(proj());
    for (const shim of MANAGED_SHIM_FILES) {
      expect(drift.missing).not.toContain(shim);
      expect(drift.userAdapted).not.toContain(shim);
      expect(drift.upstreamUpdated).not.toContain(shim);
    }
  });

  it('non-ejected harness reports no owned files and doctor skips the check', () => {
    const drift = compareHarnessToTemplate(proj());
    expect(drift.ownedByUser).toEqual([]);
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

  it('adopt removes the runtime, prunes leftover wrappers, and preserves config files', () => {
    const envBefore = fs.readFileSync(har('harness.env'), 'utf8');
    const stagesBefore = fs.readFileSync(har('stages.json'), 'utf8');

    ejectHarness(proj());
    fs.writeFileSync(
      har('launch.sh'),
      '#!/usr/bin/env bash\n# EJECTED runtime leftover\nexec node "$SCRIPT_DIR/runtime/har.cjs" env launch "$@"\n',
    );
    const result = adoptHarness(proj());

    expect(result.scripts).toContain('launch.sh');
    expect(fs.existsSync(har(EJECTED_RUNTIME_DIR))).toBe(false);
    expect(fs.existsSync(har('launch.sh'))).toBe(false);

    const manifest = readManifest(proj());
    expect(manifest?.ejected).toBeUndefined();
    expect(manifest?.ejectedVersion).toBeUndefined();
    expect(fs.readFileSync(har('harness.env'), 'utf8')).toBe(envBefore);
    expect(fs.readFileSync(har('stages.json'), 'utf8')).toBe(stagesBefore);
  });
});
