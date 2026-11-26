import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  buildVerificationTrace,
  cicdTaskType,
  exportVerificationTrace,
  stageStatusToCicdResult,
  verificationRunSpanId,
  verificationStageSpanId,
  verificationTraceId,
  willExportVerificationSpans,
  type VerificationTraceInput,
} from '../src/core/verification-spans';
import { sanitizeGitRemoteUrl } from '../src/core/git-remote';
import { buildOtelResourceAttributes } from '../src/core/telemetry-env';
import { encodeOtlpAttributes, unixNanoString } from '../src/utils/otlp-json';
import { buildOtlpDestination, writeTelemetryDestinations } from '../src/core/telemetry-destinations';
import { runVerification } from '../src/core/run-service';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

// Same stub as verify-validation.test.ts: exercise the core path, not the stage runner.
jest.mock('../src/runtime', () => {
  const actual = jest.requireActual('../src/runtime');
  return {
    ...actual,
    buildVerifyPlan: jest.fn((_repo: string, agentId: number) => ({
      shellCommand:
        "echo '" +
        JSON.stringify({
          status: 'fail',
          agent_id: agentId,
          total_ms: 30,
          stages: [
            { name: 'build', pass: true, ms: 10 },
            { name: 'unit-tests', pass: false, ms: 20 },
          ],
        }) +
        "'; exit 1",
      cwd: process.cwd(),
      env: process.env,
    })),
  };
});

const VALIDATION_ID = '11111111-2222-4333-8444-555555555555';
const RUN_ID = '2026-11-22/10-00-00_verify_agent-2';
const ATTEMPT_ID = '66666666-7777-4888-8999-000000000000';
const TREE = 'a'.repeat(40);

function sampleInput(overrides: Partial<VerificationTraceInput> = {}): VerificationTraceInput {
  return {
    id: VALIDATION_ID,
    runId: RUN_ID,
    full: true,
    verification: {
      status: 'fail',
      agent_id: 2,
      total_ms: 3_000,
      stages: [
        { name: 'typecheck', pass: true, ms: 1_000 },
        { name: 'unit-tests', pass: false, ms: 2_000, output: 'secret log text' },
      ],
    },
    startedAtMs: Date.parse('2026-11-22T10:00:00.000Z'),
    finishedAtMs: Date.parse('2026-11-22T10:00:03.500Z'),
    treeHash: TREE,
    headRevision: 'b'.repeat(40),
    workUnitId: 'FE-42',
    workUnitSource: 'linear',
    attemptId: ATTEMPT_ID,
    repositoryUrl: 'https://github.com/acme/app.git',
    branch: 'feat/x-har-agent-2',
    producerVersion: '2.0.0',
    ...overrides,
  };
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function spansOf(payload: Json): Json[] {
  return payload.resourceSpans[0].scopeSpans[0].spans;
}

function attrs(list: Json[]): Record<string, unknown> {
  return Object.fromEntries(list.map((kv) => [kv.key, Object.values(kv.value)[0]]));
}

function sha(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

describe('verification span ids', () => {
  it('derives the trace id as sha256("factory-run:" + run id), first 32 hex chars (Factory Commits vector)', () => {
    expect(verificationTraceId('01JD4X7Q')).toBe('08a4c2fcb06d20d6c9f76d79addde080');
  });

  it('derives deterministic trace and span ids from the run id', () => {
    expect(verificationTraceId(VALIDATION_ID)).toBe(sha(`factory-run:${VALIDATION_ID}`).slice(0, 32));
    expect(verificationRunSpanId(VALIDATION_ID)).toBe(sha(`har-verify-span:${VALIDATION_ID}`).slice(0, 16));
    expect(verificationStageSpanId(VALIDATION_ID, 'lint')).toBe(
      sha(`har-verify-span:${VALIDATION_ID}:lint`).slice(0, 16),
    );
    expect(verificationTraceId(VALIDATION_ID)).toMatch(/^[0-9a-f]{32}$/);
    expect(verificationStageSpanId(VALIDATION_ID, 'a')).not.toBe(verificationStageSpanId(VALIDATION_ID, 'b'));
  });
});

describe('result mapping', () => {
  it('follows the profile table', () => {
    expect(stageStatusToCicdResult('passed')).toBe('success');
    expect(stageStatusToCicdResult('failed')).toBe('failure');
    expect(stageStatusToCicdResult('error')).toBe('error');
    expect(stageStatusToCicdResult('skipped')).toBe('skip');
  });

  it('sets the task type only when the stage id says so', () => {
    expect(cicdTaskType('build')).toBe('build');
    expect(cicdTaskType('docs-build')).toBe('build');
    expect(cicdTaskType('unit-tests')).toBe('test');
    expect(cicdTaskType('fixture-e2e')).toBe('test');
    expect(cicdTaskType('typecheck')).toBeUndefined();
    expect(cicdTaskType('lint')).toBeUndefined();
  });
});

describe('OTLP/JSON encoding', () => {
  it('types attribute values and drops empty ones', () => {
    expect(encodeOtlpAttributes({ s: 'x', i: 3, d: 1.5, b: false, u: undefined, e: '' })).toEqual([
      { key: 's', value: { stringValue: 'x' } },
      { key: 'i', value: { intValue: '3' } },
      { key: 'd', value: { doubleValue: 1.5 } },
      { key: 'b', value: { boolValue: false } },
    ]);
    expect(unixNanoString(1_700_000_000_123)).toBe('1700000000123000000');
  });

  it('encodes one full verify run as a run span with stage children', () => {
    const payload = buildVerificationTrace(sampleInput()) as Json;
    expect(payload).toMatchSnapshot();

    const [run, typecheck, unit] = spansOf(payload);
    expect(run.parentSpanId).toBeUndefined();
    expect(typecheck.parentSpanId).toBe(run.spanId);
    expect(unit.parentSpanId).toBe(run.spanId);
    expect(new Set(spansOf(payload).map((span) => span.traceId)).size).toBe(1);
    expect(attrs(run.attributes)).toMatchObject({
      'cicd.pipeline.name': 'har verify --full',
      'cicd.pipeline.run.id': VALIDATION_ID,
      'factory.run.id': VALIDATION_ID,
      'cicd.pipeline.result': 'failure',
      'factory.verdict': 'fail',
      'factory.git.tree': TREE,
    });
    expect(attrs(unit.attributes)['cicd.pipeline.task.run.result']).toBe('failure');
    expect(attrs(typecheck.attributes)['cicd.pipeline.task.run.result']).toBe('success');
    expect(JSON.stringify(payload)).not.toContain('secret log text');
  });

  it('marks a run without a parsed result as error and omits the verdict on quick runs', () => {
    const errored = spansOf(buildVerificationTrace(sampleInput({ verification: null })) as Json);
    expect(errored).toHaveLength(1);
    expect(attrs(errored[0].attributes)['cicd.pipeline.result']).toBe('error');

    const quick = spansOf(buildVerificationTrace(sampleInput({ full: false })) as Json)[0];
    expect(attrs(quick.attributes)['cicd.pipeline.name']).toBe('har verify');
    expect(attrs(quick.attributes)).not.toHaveProperty('factory.verdict');
  });

  it('strips credentials from repository URLs', () => {
    expect(sanitizeGitRemoteUrl('https://user:tok@github.com/acme/app.git?x=1')).toBe(
      'https://github.com/acme/app.git',
    );
    expect(sanitizeGitRemoteUrl('git@github.com:acme/app.git')).toBe('ssh://github.com/acme/app.git');
    expect(sanitizeGitRemoteUrl('/srv/git/app')).toBeUndefined();
  });

  it('keys the trace on the validation and the span ids on the run', () => {
    const first = spansOf(buildVerificationTrace(sampleInput()) as Json);
    const second = spansOf(buildVerificationTrace(sampleInput({ runId: `${RUN_ID}-b` })) as Json);
    expect(first[0].traceId).toBe(verificationTraceId(VALIDATION_ID));
    expect(second[0].traceId).toBe(first[0].traceId);
    expect(first[0].spanId).toBe(verificationRunSpanId(RUN_ID));
    expect(first[1].spanId).toBe(verificationStageSpanId(RUN_ID, 'typecheck'));
    expect(second[0].spanId).not.toBe(first[0].spanId);
    expect(second[1].spanId).not.toBe(first[1].spanId);
    // The factory run id stays the validation id (= predicate.run.id).
    expect(attrs(second[0].attributes)['factory.run.id']).toBe(VALIDATION_ID);
  });

  it('falls back to the id for span ids when no run id is known', () => {
    const [run, stage] = spansOf(buildVerificationTrace(sampleInput({ runId: undefined })) as Json);
    expect(run.spanId).toBe(verificationRunSpanId(VALIDATION_ID));
    expect(stage.spanId).toBe(verificationStageSpanId(VALIDATION_ID, 'typecheck'));
  });

  it('carries the attestation digest on the run span only when one was attested', () => {
    const digest = `sha256:${'c'.repeat(64)}`;
    const [run, stage] = spansOf(buildVerificationTrace(sampleInput({ attestationDigest: digest })) as Json);
    expect(attrs(run.attributes)['factory.attestation.digest']).toBe(digest);
    expect(attrs(stage.attributes)).not.toHaveProperty('factory.attestation.digest');
    const [plain] = spansOf(buildVerificationTrace(sampleInput()) as Json);
    expect(attrs(plain.attributes)).not.toHaveProperty('factory.attestation.digest');
  });
});

describe('correlation keys', () => {
  // A backend joins agent sessions and verification traces on these.
  const CORRELATION_KEYS = [
    'factory.work_unit.id',
    'factory.work_unit.source',
    'factory.attempt.id',
    'vcs.repository.url.full',
    'vcs.ref.head.name',
    'factory.producer.name',
    'factory.producer.version',
  ];

  it('are identical on agent sessions and verification spans for the same session', () => {
    const input = sampleInput();
    const sessionAttrs = Object.fromEntries(
      buildOtelResourceAttributes({
        sessionKey: input.branch!,
        agentId: 2,
        repoPath: '/repo',
        workDir: '/repo-worktree',
        branch: input.branch,
        workUnitId: input.workUnitId,
        workUnitSource: input.workUnitSource,
        attemptId: input.attemptId,
        repositoryUrl: input.repositoryUrl,
        producerVersion: input.producerVersion,
      })
        .split(',')
        .map((pair) => pair.split('=') as [string, string])
        .filter(([key]) => CORRELATION_KEYS.includes(key)),
    );
    const resource = attrs((buildVerificationTrace(input) as Json).resourceSpans[0].resource.attributes);
    const spanAttrs = Object.fromEntries(Object.entries(resource).filter(([key]) => CORRELATION_KEYS.includes(key)));

    expect(Object.keys(sessionAttrs).sort()).toEqual([...CORRELATION_KEYS].sort());
    expect(spanAttrs).toEqual(sessionAttrs);
  });
});

describe('exportVerificationTrace', () => {
  let env: NodeJS.ProcessEnv;
  const savedTelemetry = process.env.HAR_TELEMETRY;

  beforeEach(() => {
    env = { HAR_DESTINATIONS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'har-vspans-')) };
    process.env.HAR_TELEMETRY = 'full';
  });
  afterEach(() => {
    if (savedTelemetry === undefined) delete process.env.HAR_TELEMETRY;
    else process.env.HAR_TELEMETRY = savedTelemetry;
  });

  function okFetch() {
    return jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  }

  it('willExportVerificationSpans needs telemetry on and an enabled traces destination', () => {
    expect(willExportVerificationSpans(env)).toBe(false);
    writeTelemetryDestinations(
      {
        version: 1,
        destinations: [
          buildOtlpDestination({ name: 'logs-only', endpoint: 'http://127.0.0.1:4319', signals: ['logs'] }),
          buildOtlpDestination({ name: 'disabled', endpoint: 'http://127.0.0.1:4320', enabled: false }),
        ],
      },
      env,
    );
    expect(willExportVerificationSpans(env)).toBe(false);
    writeTelemetryDestinations(
      { version: 1, destinations: [buildOtlpDestination({ name: 'col', endpoint: 'http://127.0.0.1:4318' })] },
      env,
    );
    expect(willExportVerificationSpans(env)).toBe(true);
    process.env.HAR_TELEMETRY = 'off';
    expect(willExportVerificationSpans(env)).toBe(false);
  });

  it('willExportVerificationSpans is true when Mission Control will receive the trace, even with no destination', () => {
    expect(willExportVerificationSpans(env)).toBe(false);
    expect(willExportVerificationSpans({ ...env, HAR_TEST_VERIFICATION_TRACE_CONTROL: 'on' })).toBe(true);
    process.env.HAR_CONTROL_DISABLED = 'true';
    try {
      expect(willExportVerificationSpans({ ...env, HAR_TEST_VERIFICATION_TRACE_CONTROL: 'on' })).toBe(false);
    } finally {
      delete process.env.HAR_CONTROL_DISABLED;
    }
  });

  it('does nothing without destinations', async () => {
    const fetchImpl = okFetch();
    const resolve = jest.fn(() => sampleInput());
    const result = await exportVerificationTrace(resolve, { env, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does nothing when telemetry is off', async () => {
    writeTelemetryDestinations(
      { version: 1, destinations: [buildOtlpDestination({ name: 'col', endpoint: 'http://127.0.0.1:4318' })] },
      env,
    );
    process.env.HAR_TELEMETRY = 'off';
    const fetchImpl = okFetch();
    const result = await exportVerificationTrace(() => sampleInput(), {
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('posts OTLP/JSON to every enabled traces destination and reports failures', async () => {
    writeTelemetryDestinations(
      {
        version: 1,
        destinations: [
          buildOtlpDestination({ name: 'col', endpoint: 'http://127.0.0.1:4318/', headers: { 'x-api-key': 'k' } }),
          buildOtlpDestination({ name: 'down', endpoint: 'http://127.0.0.1:9' }),
          buildOtlpDestination({ name: 'logs-only', endpoint: 'http://127.0.0.1:4319', signals: ['logs'] }),
          buildOtlpDestination({ name: 'disabled', endpoint: 'http://127.0.0.1:4320', enabled: false }),
        ],
      },
      env,
    );
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.startsWith('http://127.0.0.1:9/')) throw new Error('connect ECONNREFUSED');
      return new Response('', { status: 200 });
    });
    const result = await exportVerificationTrace(() => sampleInput(), {
      env,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ destinations: 2, failed: ['down'] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4318/v1/traces');
    expect(init.headers).toMatchObject({ 'x-api-key': 'k', 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual(buildVerificationTrace(sampleInput()));
  });
});

describe('runVerification emits verification spans', () => {
  const savedTelemetry = process.env.HAR_TELEMETRY;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.HAR_TELEMETRY = 'full';
    fs.rmSync(process.env.HAR_DESTINATIONS_DIR!, { recursive: true, force: true });
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
    fs.rmSync(process.env.HAR_DESTINATIONS_DIR!, { recursive: true, force: true });
    if (savedTelemetry === undefined) delete process.env.HAR_TELEMETRY;
    else process.env.HAR_TELEMETRY = savedTelemetry;
  });

  function initHarnessRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-vspans-repo-'));
    fs.cpSync(path.join(FIXTURE, '.har'), path.join(dir, '.har'), { recursive: true });
    const sh = (command: string) => execSync(command, { cwd: dir, stdio: 'pipe' });
    sh('git init -q -b main');
    sh('git config user.email har@test.local');
    sh('git config user.name har');
    sh('git remote add origin https://user:token@github.com/acme/app.git');
    fs.writeFileSync(path.join(dir, 'app.txt'), 'v1\n');
    sh('git add -A');
    sh('git commit -q -m init');
    return dir;
  }

  it('sends nothing when no destination is configured', async () => {
    fetchSpy = jest.spyOn(global, 'fetch');
    const result = await runVerification({ repoPath: initHarnessRepo(), agentId: 1, full: true, capture: true });
    expect(result.verification?.status).toBe('fail');
    expect(result.spanExport).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('keeps the verify result unchanged when the destination fails', async () => {
    writeTelemetryDestinations({
      version: 1,
      destinations: [buildOtlpDestination({ name: 'col', endpoint: 'http://127.0.0.1:4318' })],
    });
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const result = await runVerification({ repoPath: initHarnessRepo(), agentId: 1, full: true, capture: true });
    expect(result.code).toBe(1);
    expect(result.verification?.status).toBe('fail');
    expect(result.validation?.status).toBe('fail');
    expect(result.spanExport).toEqual({ destinations: 1, failed: ['col'] });
  });

  it('sends a trace keyed on the validation, with the verified tree and HEAD commit', async () => {
    writeTelemetryDestinations({
      version: 1,
      destinations: [buildOtlpDestination({ name: 'col', endpoint: 'http://127.0.0.1:4318' })],
    });
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    const dir = initHarnessRepo();
    const result = await runVerification({ repoPath: dir, agentId: 1, full: true, capture: true });
    expect(result.spanExport).toEqual({ destinations: 1, failed: [] });

    const payload = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Json;
    const validation = result.validation!;
    expect(validation.headSha).toMatch(/^[0-9a-f]{40}$/);
    const [run, ...stages] = spansOf(payload);
    expect(run.traceId).toBe(verificationTraceId(validation.validationId));
    expect(attrs(run.attributes)).toMatchObject({
      'factory.run.id': validation.validationId,
      'factory.git.tree': validation.treeHash,
      'vcs.ref.head.revision': validation.headSha,
      'cicd.pipeline.result': 'failure',
    });
    expect(stages.map((span) => attrs(span.attributes)['cicd.pipeline.task.name'])).toEqual(['build', 'unit-tests']);
    const resource = attrs(payload.resourceSpans[0].resource.attributes);
    expect(resource).toMatchObject({
      'service.name': 'har',
      'vcs.repository.url.full': 'https://github.com/acme/app.git',
      'vcs.ref.head.name': 'main',
      'factory.producer.name': 'har',
    });
    expect(JSON.stringify(payload)).not.toContain(dir);
  });

  it('puts every verify of one tree in one trace, with a run span per verify', async () => {
    writeTelemetryDestinations({
      version: 1,
      destinations: [buildOtlpDestination({ name: 'col', endpoint: 'http://127.0.0.1:4318' })],
    });
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    const dir = initHarnessRepo();
    const first = await runVerification({ repoPath: dir, agentId: 1, full: true, capture: true });
    const second = await runVerification({ repoPath: dir, agentId: 1, full: true, capture: true });
    const [runA] = spansOf(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Json);
    const [runB] = spansOf(JSON.parse((fetchSpy.mock.calls[1][1] as RequestInit).body as string) as Json);

    expect(first.validation!.treeHash).toBe(second.validation!.treeHash);
    expect(runA.traceId).toBe(runB.traceId);
    expect(runA.traceId).toBe(verificationTraceId(second.validation!.validationId));
    expect(first.validation!.runId).toBeTruthy();
    expect(first.validation!.runId).not.toBe(second.validation!.runId);
    expect(runA.spanId).toBe(verificationRunSpanId(first.validation!.runId!));
    expect(runB.spanId).toBe(verificationRunSpanId(second.validation!.runId!));
  });

  it('omits the HEAD commit when the verified tree has uncommitted changes', async () => {
    writeTelemetryDestinations({
      version: 1,
      destinations: [buildOtlpDestination({ name: 'col', endpoint: 'http://127.0.0.1:4318' })],
    });
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
    const dir = initHarnessRepo();
    fs.writeFileSync(path.join(dir, 'app.txt'), 'v2\n');
    const result = await runVerification({ repoPath: dir, agentId: 1, full: false, capture: true });
    const payload = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Json;
    const runAttrs = attrs(spansOf(payload)[0].attributes);
    expect(runAttrs['factory.git.tree']).toBe(result.validation!.treeHash);
    expect(runAttrs).not.toHaveProperty('vcs.ref.head.revision');
    expect(runAttrs).not.toHaveProperty('factory.verdict');
  });
});

describe('Factory Commits proof <-> verification trace', () => {
  const FAKE_BIN = path.join(__dirname, 'fixtures', 'factory-commits', 'fake-git-factory');
  const saved = { telemetry: process.env.HAR_TELEMETRY, bin: process.env.HAR_FACTORY_PROOF_BIN };
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env.HAR_TELEMETRY = 'full';
    process.env.HAR_FACTORY_PROOF_BIN = FAKE_BIN;
    fs.rmSync(process.env.HAR_DESTINATIONS_DIR!, { recursive: true, force: true });
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('', { status: 200 }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(process.env.HAR_DESTINATIONS_DIR!, { recursive: true, force: true });
    for (const [key, value] of [
      ['HAR_TELEMETRY', saved.telemetry],
      ['HAR_FACTORY_PROOF_BIN', saved.bin],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function initProofRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-vspans-proof-'));
    fs.cpSync(path.join(FIXTURE, '.har'), path.join(dir, '.har'), { recursive: true });
    fs.appendFileSync(path.join(dir, '.har', 'harness.env'), '\nHAR_FACTORY_PROOF=notes\n');
    const sh = (command: string) => execSync(command, { cwd: dir, stdio: 'pipe' });
    sh('git init -q -b main');
    sh('git config user.email har@test.local');
    sh('git config user.name har');
    fs.writeFileSync(path.join(dir, 'app.txt'), 'v1\n');
    sh('git add -A');
    sh('git commit -q -m init');
    return dir;
  }

  function attestedPredicate(attestationFile: string): Json {
    const entry = JSON.parse(fs.readFileSync(attestationFile, 'utf8')) as { envelope: { payload: string } };
    return JSON.parse(Buffer.from(entry.envelope.payload, 'base64').toString('utf8')).predicate;
  }

  it('links the predicate to the exported trace and the run span to the statement digest', async () => {
    writeTelemetryDestinations({
      version: 1,
      destinations: [buildOtlpDestination({ name: 'col', endpoint: 'http://127.0.0.1:4318' })],
    });
    const result = await runVerification({ repoPath: initProofRepo(), agentId: 1, full: true, capture: true });
    expect(result.proof?.status).toBe('attested');

    const predicate = attestedPredicate(result.proof!.attestationFile!);
    const [run] = spansOf(JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string) as Json);
    expect(predicate.telemetry).toEqual({ traceId: run.traceId });
    expect(predicate.run.id).toBe(attrs(run.attributes)['factory.run.id']);
    expect(attrs(run.attributes)['factory.attestation.digest']).toBe(result.proof!.digest);
  });

  it('never names a trace in the predicate when no trace is sent', async () => {
    const result = await runVerification({ repoPath: initProofRepo(), agentId: 1, full: true, capture: true });
    expect(result.proof?.status).toBe('attested');
    expect(result.spanExport).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(attestedPredicate(result.proof!.attestationFile!)).not.toHaveProperty('telemetry');
  });

  it('never names a trace when telemetry is off, even with a destination', async () => {
    writeTelemetryDestinations({
      version: 1,
      destinations: [buildOtlpDestination({ name: 'col', endpoint: 'http://127.0.0.1:4318' })],
    });
    process.env.HAR_TELEMETRY = 'off';
    const result = await runVerification({ repoPath: initProofRepo(), agentId: 1, full: true, capture: true });
    expect(result.proof?.status).toBe('attested');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(attestedPredicate(result.proof!.attestationFile!)).not.toHaveProperty('telemetry');
  });
});
