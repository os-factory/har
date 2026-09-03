import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatDoctorReport, runDoctor, summarizeDoctorReport } from '../src/harness/doctor';

const HARNESS_ENV_1_0 = [
  '# 1.0 pure-config harness.env',
  'export HARNESS_PROJECT_NAME=doctor-fixture',
  'export HARNESS_ECOSYSTEM=node',
  'export HARNESS_AGENT_SLOT_MIN=1',
  'export HARNESS_AGENT_SLOT_MAX=3',
  'export HARNESS_INFRA_SERVICES=""',
  'export HARNESS_INFRA_PORT_LANES="db=15432:15432-15499 minio=19000:19000-19099"',
  '',
].join('\n');

function writeStages(repo: string, registry: Record<string, unknown>): void {
  fs.writeFileSync(path.join(repo, '.har', 'stages.json'), JSON.stringify(registry, null, 2));
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-doctor-'));
  const harnessDir = path.join(repo, '.har');
  fs.mkdirSync(path.join(harnessDir, 'stages'), { recursive: true });
  fs.writeFileSync(path.join(harnessDir, 'harness.env'), HARNESS_ENV_1_0);
  const stageScript = path.join(harnessDir, 'stages', 'unit-tests.sh');
  fs.writeFileSync(stageScript, '#!/usr/bin/env bash\ntrue\n');
  fs.chmodSync(stageScript, 0o755);
  writeStages(repo, {
    version: '1',
    agentSlots: { min: 1, max: 3 },
    verificationStages: ['typecheck', 'unit-tests'],
    stages: [
      { id: 'launch', kind: 'launch' },
      { id: 'verify', kind: 'verify' },
      { id: 'teardown', kind: 'teardown' },
      { id: 'typecheck', kind: 'test', tier: 'quick', command: 'npm run typecheck' },
      { id: 'unit-tests', kind: 'test', tier: 'full', script: 'stages/unit-tests.sh' },
    ],
  });
  return repo;
}

afterEach(() => {
  // repos are per-test temp dirs; nothing shared to clean
});

describe('har env doctor (#232)', () => {
  it('passes on a healthy 1.0 harness', () => {
    const repo = makeRepo();
    const report = runDoctor(repo);
    expect(report.contract).toBe('1.0');
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(report.ok).toBe(true);
    // ejected-runtime (#239) is skipped on a non-ejected harness by design.
    // cli-version (#344) is skipped until a writer stamps manifest.cliVersion.
    expect(
      report.checks.every(
        (c) =>
          c.status === 'pass' ||
          ((c.id === 'ejected-runtime' || c.id === 'cli-version') && c.status === 'skip'),
      ),
    ).toBe(true);
    expect(summarizeDoctorReport(report)).toBeNull();
  });

  it('fails with an actionable message when a stage script is deleted', () => {
    const repo = makeRepo();
    fs.rmSync(path.join(repo, '.har', 'stages', 'unit-tests.sh'));
    const report = runDoctor(repo);
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.check === 'stage-files');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('unit-tests');
    expect(finding?.message).toContain('stages/unit-tests.sh');
    expect(finding?.remedy).toContain('stages.json');
  });

  it('fails on a misnamed verification id', () => {
    const repo = makeRepo();
    const registry = JSON.parse(fs.readFileSync(path.join(repo, '.har', 'stages.json'), 'utf8'));
    registry.verificationStages = ['typecheck', 'unit-test']; // typo
    writeStages(repo, registry);
    const report = runDoctor(repo);
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.check === 'verification-ids');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('unit-test');
  });

  it('fails on corrupted stages.json even on a pre-1.0 harness', () => {
    const repo = makeRepo();
    fs.appendFileSync(path.join(repo, '.har', 'harness.env'), '\nhar_pg() {\n  true\n}\n');
    fs.writeFileSync(path.join(repo, '.har', 'stages.json'), '{"broken": true');
    const report = runDoctor(repo);
    expect(report.contract).toBe('pre-1.0');
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.check === 'stages-registry');
    expect(finding?.severity).toBe('error');
    expect(finding?.remedy).toContain('stages.json');
    // downstream registry checks are skipped, not spuriously failed
    expect(report.checks.find((c) => c.id === 'stage-files')?.status).toBe('skip');
  });

  it('fails when stages.json parses but has no stages array, on any contract', () => {
    const repo = makeRepo();
    fs.appendFileSync(path.join(repo, '.har', 'harness.env'), '\nhar_pg() {\n  true\n}\n');
    fs.writeFileSync(path.join(repo, '.har', 'stages.json'), '{"broken": true}');
    const report = runDoctor(repo);
    expect(report.contract).toBe('pre-1.0');
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.check === 'stages-registry');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('structurally invalid');
  });

  it('fails on corrupted harness.env (unknown key) on a 1.0 harness', () => {
    const repo = makeRepo();
    fs.appendFileSync(path.join(repo, '.har', 'harness.env'), 'export HARNESS_ECOSYSTM=node\n');
    const report = runDoctor(repo);
    expect(report.contract).toBe('1.0');
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.check === 'harness-env');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('HARNESS_ECOSYSTEM'); // did-you-mean
  });

  it('degrades contract findings to warnings on a pre-1.0 harness', () => {
    const repo = makeRepo();
    fs.appendFileSync(
      path.join(repo, '.har', 'harness.env'),
      '\nexport HARNESS_DB_PORT_DEFAULT=15432\nhar_infra_enabled() {\n  true\n}\n',
    );
    const report = runDoctor(repo);
    expect(report.contract).toBe('pre-1.0');
    expect(report.ok).toBe(true);
    expect(report.findings.length).toBeGreaterThan(0);
    expect(report.findings.every((f) => f.severity === 'warning')).toBe(true);
    expect(summarizeDoctorReport(report)).toContain('har env doctor');
  });

  it('fails when a lifecycle stage is missing', () => {
    const repo = makeRepo();
    const registry = JSON.parse(fs.readFileSync(path.join(repo, '.har', 'stages.json'), 'utf8'));
    registry.stages = registry.stages.filter((s: { kind: string }) => s.kind !== 'teardown');
    writeStages(repo, registry);
    const report = runDoctor(repo);
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.check === 'lifecycle-stages');
    expect(finding?.message).toContain('teardown');
  });

  it('flags overlapping port lanes', () => {
    const repo = makeRepo();
    let env = fs.readFileSync(path.join(repo, '.har', 'harness.env'), 'utf8');
    env = env.replace(
      /^export HARNESS_INFRA_PORT_LANES=.*$/m,
      'export HARNESS_INFRA_PORT_LANES="db=15432:15432-15499 minio=15450:15450-15549"',
    );
    fs.writeFileSync(path.join(repo, '.har', 'harness.env'), env);
    const report = runDoctor(repo);
    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.check === 'port-lanes');
    expect(finding?.message).toContain('overlap');
  });

  it('warns when a slot registry entry points at a missing worktree', () => {
    const repo = makeRepo();
    const slotsDir = path.join(repo, '.har', 'slots');
    fs.mkdirSync(slotsDir, { recursive: true });
    fs.writeFileSync(
      path.join(slotsDir, 'agent-2.json'),
      JSON.stringify({
        version: 1,
        agentId: 2,
        projectName: 'doctor-fixture',
        mode: 'worktree',
        workDir: path.join(repo, 'gone-worktree'),
        worktreePath: path.join(repo, 'gone-worktree'),
        createdAt: new Date().toISOString(),
        status: 'active',
      }),
    );
    const report = runDoctor(repo);
    expect(report.ok).toBe(true); // stale slot is a warning, not an error
    const finding = report.findings.find((f) => f.check === 'slot-registry');
    expect(finding?.severity).toBe('warning');
    expect(finding?.remedy).toContain('teardown 2');
  });

  it('reports a missing .har/ directory as an error', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-doctor-none-'));
    const report = runDoctor(repo);
    expect(report.ok).toBe(false);
    expect(report.contract).toBe('none');
    expect(report.findings[0].remedy).toContain('har onboard');
  });

  it('fails with a single upgrade error when the CLI is older than the harness writer (#344)', () => {
    const repo = makeRepo();
    fs.writeFileSync(
      path.join(repo, '.har', 'manifest.json'),
      JSON.stringify({
        version: '1',
        runtimeVersion: '1.0.0',
        cliVersion: '99.0.0',
        outputDir: '.har',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    fs.rmSync(path.join(repo, '.har', 'stages', 'unit-tests.sh'));
    const report = runDoctor(repo);
    expect(report.ok).toBe(false);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].check).toBe('cli-version');
    expect(report.findings[0].message).toContain('99.0.0');
    expect(report.findings[0].remedy).toContain('npm install -g @osfactory/har@latest');
    expect(report.findings.some((f) => f.check === 'stage-files')).toBe(false);
    expect(
      report.checks.filter((c) => c.id !== 'cli-version').every((c) => c.status === 'skip'),
    ).toBe(true);
  });

  it('still reports missing stage files when the CLI matches the harness writer', () => {
    const repo = makeRepo();
    fs.writeFileSync(
      path.join(repo, '.har', 'manifest.json'),
      JSON.stringify({
        version: '1',
        runtimeVersion: '1.0.0',
        cliVersion: '1.0.0',
        outputDir: '.har',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    const original = process.env.HAR_PACKAGE_VERSION;
    process.env.HAR_PACKAGE_VERSION = '1.0.0';
    try {
      fs.rmSync(path.join(repo, '.har', 'stages', 'unit-tests.sh'));
      const report = runDoctor(repo);
      expect(report.ok).toBe(false);
      expect(report.findings.find((f) => f.check === 'cli-version')).toBeUndefined();
      expect(report.checks.find((c) => c.id === 'cli-version')?.status).toBe('pass');
      expect(report.findings.find((f) => f.check === 'stage-files')?.message).toContain(
        'unit-tests',
      );
    } finally {
      if (original === undefined) delete process.env.HAR_PACKAGE_VERSION;
      else process.env.HAR_PACKAGE_VERSION = original;
    }
  });

  it('renders a readable report with remedies', () => {
    const repo = makeRepo();
    fs.rmSync(path.join(repo, '.har', 'stages', 'unit-tests.sh'));
    const text = formatDoctorReport(runDoctor(repo));
    expect(text).toContain('✗ stage scripts & commands');
    expect(text).toContain('→ Restore .har/stages/unit-tests.sh');
    expect(text).toContain('Doctor: FAIL');
  });
});

describe('doctor lifecycle hooks check (#238)', () => {
  it('passes silently with valid executable hooks', () => {
    const repo = makeRepo();
    const hooksDir = path.join(repo, '.har', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const hook = path.join(hooksDir, 'pre-launch.sh');
    fs.writeFileSync(hook, '#!/usr/bin/env bash\ntrue\n');
    fs.chmodSync(hook, 0o755);
    const report = runDoctor(repo);
    expect(report.findings.filter((f) => f.check === 'hooks')).toEqual([]);
    expect(report.checks.find((c) => c.id === 'hooks')?.status).toBe('pass');
  });

  it('warns on a non-executable hook', () => {
    const repo = makeRepo();
    const hooksDir = path.join(repo, '.har', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-verify.sh'), '#!/usr/bin/env bash\ntrue\n');
    fs.chmodSync(path.join(hooksDir, 'pre-verify.sh'), 0o644);
    const report = runDoctor(repo);
    const findings = report.findings.filter((f) => f.check === 'hooks');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].message).toContain('not executable');
    expect(report.ok).toBe(true); // warning, not error
  });

  it('warns on an unrecognized hook name', () => {
    const repo = makeRepo();
    const hooksDir = path.join(repo, '.har', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const hook = path.join(hooksDir, 'mid-launch.sh');
    fs.writeFileSync(hook, '#!/usr/bin/env bash\ntrue\n');
    fs.chmodSync(hook, 0o755);
    const report = runDoctor(repo);
    const findings = report.findings.filter((f) => f.check === 'hooks');
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('not a recognized lifecycle hook');
  });
});
