import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import Ajv2020 from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import {
  attestationFilePath,
  buildFactoryRunPredicate,
  FACTORY_PROOF_POLICY_ID,
  produceValidationProof,
  readAttestationEntry,
  readFactoryProofMode,
  resolveFactoryProofMode,
  DEFAULT_FACTORY_PROOF_MODE,
  resolveFactoryProofBin,
} from '../src/core/proof';
import { findValidation, recordValidation } from '../src/core/validations';
import { HarnessStageRegistrySchema, ValidationRecordSchema, VerificationResult } from '../src/harness/schema';

// Vendored from the Factory Commits repository (v0.1 draft):
// https://github.com/os-factory/factory-commits/blob/main/schemas/factory-run.predicate.schema.json
const PREDICATE_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'factory-commits', 'factory-run.predicate.schema.json'), 'utf8'),
);
const FAKE_BIN = path.join(__dirname, 'fixtures', 'factory-commits', 'fake-git-factory');

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validatePredicate = ajv.compile(PREDICATE_SCHEMA);

function expectValidPredicate(predicate: unknown): void {
  const ok = validatePredicate(predicate);
  if (!ok) throw new Error(JSON.stringify(validatePredicate.errors, null, 2));
}

const registry = HarnessStageRegistrySchema.parse({
  version: '1',
  verificationStages: ['typecheck', 'unit-tests', 'lint'],
  stages: [
    { id: 'verify', kind: 'verify' },
    { id: 'typecheck', kind: 'test', tier: 'quick', command: 'true' },
    { id: 'unit-tests', kind: 'test', command: 'true' },
    { id: 'lint', kind: 'custom', command: 'true' },
  ],
});

const validation = { validationId: '6f1c2b8e-1d2a-4c3b-9e4f-0a1b2c3d4e5f' };

function verification(stages: VerificationResult['stages']): VerificationResult {
  return { status: stages.every((s) => s.pass) ? 'pass' : 'fail', agent_id: 3, stages };
}

describe('buildFactoryRunPredicate', () => {
  it('maps a passing full validation to a schema-valid factory-run predicate', () => {
    const predicate = buildFactoryRunPredicate({
      validation,
      verification: verification([
        { name: 'typecheck', pass: true, ms: 1200.4 },
        { name: 'unit-tests', pass: true, ms: 30000 },
        { name: 'lint', pass: true, ms: 900 },
      ]),
      registry,
      policyDigest: 'a'.repeat(64),
      run: { startedAt: '2026-11-22T10:00:00.000Z', finishedAt: '2026-11-22T10:01:00.000Z' },
      workUnit: { id: 'v2-factory-proof', source: 'github', attemptId: 'b1e2c3d4-0000-4000-8000-000000000001' },
      producerVersion: '1.30.0',
      env: {},
    });

    expectValidPredicate(predicate);
    expect(predicate).toEqual({
      run: { id: validation.validationId, startedOn: '2026-11-22T10:00:00.000Z', finishedOn: '2026-11-22T10:01:00.000Z' },
      workUnit: { id: 'v2-factory-proof', source: 'github', attemptId: 'b1e2c3d4-0000-4000-8000-000000000001' },
      policy: { id: FACTORY_PROOF_POLICY_ID, digest: { sha256: 'a'.repeat(64) }, required: ['typecheck', 'unit-tests', 'lint'] },
      stages: [
        { id: 'typecheck', status: 'passed', addedBy: 'policy', kind: 'test', durationMs: 1200 },
        { id: 'unit-tests', status: 'passed', addedBy: 'policy', kind: 'test', durationMs: 30000 },
        { id: 'lint', status: 'passed', addedBy: 'policy', kind: 'custom', durationMs: 900 },
      ],
      verdict: 'pass',
      producer: { name: 'har', version: '1.30.0' },
      environment: { trust: 'local', executor: 'local' },
    });
  });

  it('records a failing validation with verdict fail (SPEC §4.3) and maps unrunnable stages to error', () => {
    const predicate = buildFactoryRunPredicate({
      validation,
      verification: verification([
        { name: 'typecheck', pass: true, ms: 10 },
        { name: 'unit-tests', pass: false, ms: 20, output: 'FAIL tests/x.test.ts at /home/someone/project' },
        { name: 'lint', pass: false, ms: 0, output: 'stage has neither script nor command' },
      ]),
      registry,
      producerVersion: '1.30.0',
      env: { CI: 'true', GITHUB_ACTIONS: 'true' },
    });

    expectValidPredicate(predicate);
    expect(predicate.verdict).toBe('fail');
    expect(predicate.stages.map((s) => s.status)).toEqual(['passed', 'failed', 'error']);
    expect(predicate.environment).toEqual({ trust: 'ci', executor: 'github-actions' });
    expect(predicate.workUnit).toBeUndefined();
    // Privacy: stage output (and the paths in it) never reaches the predicate.
    expect(JSON.stringify(predicate)).not.toContain('/home/');
  });

  it('fails the verdict when a required stage never ran', () => {
    const predicate = buildFactoryRunPredicate({
      validation,
      verification: verification([{ name: 'typecheck', pass: true, ms: 1 }]),
      registry,
      producerVersion: '1.30.0',
      env: {},
    });
    expectValidPredicate(predicate);
    expect(predicate.verdict).toBe('fail');
  });

  it('links the verification trace only with a well-formed trace id', () => {
    const base = {
      validation,
      verification: verification([{ name: 'typecheck', pass: true }]),
      registry,
      producerVersion: '2.0.0',
      env: {},
    };
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const linked = buildFactoryRunPredicate({ ...base, telemetry: { traceId } });
    expect(linked.telemetry).toEqual({ traceId });
    expectValidPredicate(linked);
    expect(buildFactoryRunPredicate(base)).not.toHaveProperty('telemetry');
    expect(buildFactoryRunPredicate({ ...base, telemetry: { traceId: 'not-a-trace' } })).not.toHaveProperty(
      'telemetry',
    );
  });

  it('drops work-unit fields that do not fit the standard grammar', () => {
    const predicate = buildFactoryRunPredicate({
      validation,
      verification: verification([{ name: 'typecheck', pass: true }]),
      registry,
      workUnit: { id: 'FE-1', source: 'Linear Cloud' },
      producerVersion: '1.30.0',
      env: { CI: 'false' },
    });
    expectValidPredicate(predicate);
    expect(predicate.workUnit).toEqual({ id: 'FE-1' });
    expect(predicate.environment.trust).toBe('local');
  });
});

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
}

function sh(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initHarnessRepo(harnessEnv?: string): string {
  const dir = tmp('har-proof-');
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email har@test.local');
  sh(dir, 'git config user.name har');
  fs.mkdirSync(path.join(dir, '.har'));
  fs.writeFileSync(path.join(dir, '.har', '.gitignore'), 'runs/\nvalidations/\n');
  fs.writeFileSync(path.join(dir, '.har', 'stages.json'), JSON.stringify(registry, null, 2));
  if (harnessEnv !== undefined) fs.writeFileSync(path.join(dir, '.har', 'harness.env'), harnessEnv);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  sh(dir, 'git add -A');
  sh(dir, 'git commit -q -m init');
  return dir;
}

const passing = verification([
  { name: 'typecheck', pass: true, ms: 1 },
  { name: 'unit-tests', pass: true, ms: 2 },
  { name: 'lint', pass: true, ms: 3 },
]);

describe('readFactoryProofMode / resolveFactoryProofBin', () => {
  it('defaults to notes (2.0) and ignores unknown values', () => {
    expect(readFactoryProofMode(initHarnessRepo())).toBe('notes');
    expect(readFactoryProofMode(initHarnessRepo('HARNESS_PROJECT_NAME=x\n'))).toBe('notes');
    expect(readFactoryProofMode(initHarnessRepo('HAR_FACTORY_PROOF=yes\n'))).toBe('off');
    expect(readFactoryProofMode(initHarnessRepo('HAR_FACTORY_PROOF=notes\n'))).toBe('notes');
    expect(readFactoryProofMode(initHarnessRepo('export HAR_FACTORY_PROOF="notes+trailers"\n'))).toBe(
      'notes+trailers',
    );
  });

  it('prefers HAR_FACTORY_PROOF_BIN, then git-factory on PATH, else unavailable', () => {
    const binDir = tmp('har-proof-bin-');
    const onPath = path.join(binDir, 'git-factory');
    fs.copyFileSync(FAKE_BIN, onPath);
    fs.chmodSync(onPath, 0o755);

    expect(resolveFactoryProofBin({ HAR_FACTORY_PROOF_BIN: FAKE_BIN, PATH: binDir })).toBe(FAKE_BIN);
    expect(resolveFactoryProofBin({ PATH: `/nonexistent${path.delimiter}${binDir}` })).toBe(onPath);
    expect(resolveFactoryProofBin({ PATH: '/nonexistent' })).toBeUndefined();
    expect(resolveFactoryProofBin({ HAR_FACTORY_PROOF_BIN: '/nonexistent/git-factory', PATH: binDir })).toBeUndefined();
  });
});

describe('produceValidationProof', () => {
  function recordPass(dir: string) {
    return recordValidation({ checkoutDir: dir, harnessRoot: dir, status: 'pass', full: true });
  }

  it('does nothing at all when the repo opted out (off)', () => {
    const dir = initHarnessRepo('HARNESS_PROJECT_NAME=x\nHAR_FACTORY_PROOF=off\n');
    const record = recordPass(dir);
    const log = path.join(tmp('har-proof-log-'), 'calls.jsonl');

    const result = produceValidationProof({
      harnessRoot: dir,
      checkoutDir: dir,
      validation: record,
      verification: passing,
      bin: FAKE_BIN,
      env: { FAKE_GIT_FACTORY_LOG: log },
    });

    expect(result.outcome).toBeUndefined();
    expect(result.validation).toBe(record);
    expect(fs.existsSync(log)).toBe(false);
    expect(fs.existsSync(attestationFilePath(dir, record.treeHash))).toBe(false);
    expect(findValidation(dir, record.treeHash)?.attestationDigest).toBeUndefined();
  });

  it('attests the validated tree and stores the digest and entry next to the record', () => {
    const dir = initHarnessRepo('HAR_FACTORY_PROOF=notes\n');
    const harnessRoot = initHarnessRepo('HAR_FACTORY_PROOF=notes\n');
    const record = recordValidation({ checkoutDir: dir, harnessRoot, status: 'pass', full: true });
    const log = path.join(tmp('har-proof-log-'), 'calls.jsonl');

    const result = produceValidationProof({
      harnessRoot,
      checkoutDir: dir,
      validation: record,
      verification: passing,
      workUnit: { id: 'v2-factory-proof', source: 'github' },
      bin: FAKE_BIN,
      env: { FAKE_GIT_FACTORY_LOG: log },
    });

    expect(result.outcome?.status).toBe('attested');
    const digest = result.outcome?.digest;
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.validation.attestationDigest).toBe(digest);
    expect(findValidation(dir, record.treeHash)?.attestationDigest).toBe(digest);
    expect(findValidation(harnessRoot, record.treeHash)?.attestationDigest).toBe(digest);
    expect(readAttestationEntry(attestationFilePath(dir, record.treeHash))?.digest).toBe(digest);
    expect(readAttestationEntry(attestationFilePath(harnessRoot, record.treeHash))?.digest).toBe(digest);

    const [call] = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(call.argv.slice(0, 5)).toEqual(['attest', '--predicate', '-', '--tree', record.treeHash]);
    expect(call.argv).toContain('--json');

    const entry = readAttestationEntry(attestationFilePath(dir, record.treeHash)) as {
      envelope: { payload: string };
    };
    const statement = JSON.parse(Buffer.from(entry.envelope.payload, 'base64').toString('utf8'));
    expectValidPredicate(statement.predicate);
    expect(statement.predicate.run.id).toBe(record.validationId);
    expect(statement.predicate.verdict).toBe('pass');
    expect(statement.predicate.workUnit).toEqual({ id: 'v2-factory-proof', source: 'github' });
    // Privacy: no absolute local paths in what gets attested.
    expect(JSON.stringify(statement.predicate)).not.toContain(dir);
  });

  it('keeps old records valid: attestationDigest is optional', () => {
    const dir = initHarnessRepo();
    const record = recordPass(dir);
    expect(ValidationRecordSchema.parse({ ...record }).attestationDigest).toBeUndefined();
  });

  it('fails open with a one-line hint when git-factory is unavailable', () => {
    const dir = initHarnessRepo('HAR_FACTORY_PROOF=notes\n');
    const record = recordPass(dir);
    const result = produceValidationProof({
      harnessRoot: dir,
      checkoutDir: dir,
      validation: record,
      verification: passing,
      env: { PATH: '/nonexistent' },
    });
    expect(result.outcome?.status).toBe('skipped');
    expect(result.outcome?.message).toContain('git-factory not found');
    expect(result.outcome?.message).not.toContain('\n');
    expect(result.validation).toBe(record);
    expect(findValidation(dir, record.treeHash)?.attestationDigest).toBeUndefined();
  });

  it('fails open when git-factory exits 2', () => {
    const dir = initHarnessRepo('HAR_FACTORY_PROOF=notes+trailers\n');
    const record = recordPass(dir);
    const result = produceValidationProof({
      harnessRoot: dir,
      checkoutDir: dir,
      validation: record,
      verification: passing,
      bin: FAKE_BIN,
      env: { FAKE_GIT_FACTORY_EXIT: '2' },
    });
    expect(result.outcome?.status).toBe('failed');
    expect(result.outcome?.message).toContain('exited 2');
    expect(result.validation).toBe(record);
    expect(fs.existsSync(attestationFilePath(dir, record.treeHash))).toBe(false);
    expect(findValidation(dir, record.treeHash)?.attestationDigest).toBeUndefined();
  });
});

// Integration against a real `git-factory` (factory-proof). Skipped unless
// HAR_FACTORY_PROOF_BIN points at one.
const realBin = process.env.HAR_FACTORY_PROOF_BIN;
(realBin ? describe : describe.skip)('produceValidationProof with the real git-factory', () => {
  it('produces an attestation the real binary accepts', () => {
    const dir = initHarnessRepo('HAR_FACTORY_PROOF=notes\n');
    const record = recordValidation({ checkoutDir: dir, harnessRoot: dir, status: 'pass', full: true });
    const result = produceValidationProof({
      harnessRoot: dir,
      checkoutDir: dir,
      validation: record,
      verification: passing,
      bin: realBin,
    });
    expect(result.outcome?.status).toBe('attested');
    expect(result.validation.attestationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('HAR 2.0 default proof mode (HAR_FACTORY_PROOF unset)', () => {
  it('resolves to notes, not explicit; a set value is explicit', () => {
    expect(DEFAULT_FACTORY_PROOF_MODE).toBe('notes');
    expect(resolveFactoryProofMode(initHarnessRepo())).toEqual({ mode: 'notes', explicit: false });
    expect(resolveFactoryProofMode(initHarnessRepo('HAR_FACTORY_PROOF=\n'))).toEqual({ mode: 'notes', explicit: false });
    expect(resolveFactoryProofMode(initHarnessRepo('HAR_FACTORY_PROOF=notes\n'))).toEqual({ mode: 'notes', explicit: true });
    expect(resolveFactoryProofMode(initHarnessRepo('HAR_FACTORY_PROOF=off\n'))).toEqual({ mode: 'off', explicit: true });
    expect(resolveFactoryProofMode(initHarnessRepo('HAR_FACTORY_PROOF=yes\n'))).toEqual({ mode: 'off', explicit: true });
  });

  it('is silent when git-factory is unavailable: no outcome, no hint, no files', () => {
    const dir = initHarnessRepo('HARNESS_PROJECT_NAME=x\n');
    const record = recordValidation({ checkoutDir: dir, harnessRoot: dir, status: 'pass', full: true });
    const result = produceValidationProof({
      harnessRoot: dir,
      checkoutDir: dir,
      validation: record,
      verification: passing,
      env: { PATH: '/nonexistent' },
    });
    expect(result.outcome).toBeUndefined();
    expect(result.validation).toBe(record);
    expect(fs.existsSync(attestationFilePath(dir, record.treeHash))).toBe(false);
  });

  it('hints when the repo explicitly opted in and git-factory is unavailable', () => {
    const dir = initHarnessRepo('HAR_FACTORY_PROOF=notes\n');
    const record = recordValidation({ checkoutDir: dir, harnessRoot: dir, status: 'pass', full: true });
    const result = produceValidationProof({
      harnessRoot: dir,
      checkoutDir: dir,
      validation: record,
      verification: passing,
      env: { PATH: '/nonexistent' },
    });
    expect(result.outcome?.status).toBe('skipped');
    expect(result.outcome?.message).toContain('git-factory not found');
  });

  it('attests locally when git-factory is installed', () => {
    const dir = initHarnessRepo();
    const record = recordValidation({ checkoutDir: dir, harnessRoot: dir, status: 'pass', full: true });
    const log = path.join(tmp('har-proof-log-'), 'calls.jsonl');
    const result = produceValidationProof({
      harnessRoot: dir,
      checkoutDir: dir,
      validation: record,
      verification: passing,
      bin: FAKE_BIN,
      env: { FAKE_GIT_FACTORY_LOG: log },
    });
    expect(result.outcome?.status).toBe('attested');
    expect(result.validation.attestationDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { argv: string[] });
    expect(calls.map((c) => c.argv[0])).toEqual(['attest']);
  });
});
