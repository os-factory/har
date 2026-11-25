/**
 * Verification trace delivery: fan-out at the producer. The CLI sends one copy
 * to Mission Control and one to each destination, each queued in its own
 * durable retry spool entry when it is not taken, so every receiver gets each
 * trace exactly once.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  buildVerificationTrace,
  deliverVerificationTrace,
  flushVerificationTraceSpool,
  VERIFICATION_TRACE_CONTROL_TEST_ENV,
  type VerificationTraceInput,
} from '../src/core/verification-spans';
import { buildLangfuseDestination, buildOtlpDestination, writeTelemetryDestinations } from '../src/core/telemetry-destinations';
import {
  CONTROL_SKIP_FORWARD_HEADER,
  flushTelemetrySpool,
  spoolOtlpPayload,
  summarizeTelemetrySpool,
  TELEMETRY_SPOOL_DIR_ENV,
} from '../src/core/telemetry-spool';
import { runVerification } from '../src/core/run-service';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');
const CONTROL = 'http://control.test:3847';
const LANGFUSE_SECRET = 'sk-lf-do-not-spool';

jest.mock('../src/runtime', () => {
  const actual = jest.requireActual('../src/runtime');
  return {
    ...actual,
    buildVerifyPlan: jest.fn((_repo: string, agentId: number) => ({
      shellCommand:
        "echo '" +
        JSON.stringify({
          status: 'pass',
          agent_id: agentId,
          total_ms: 10,
          stages: [{ name: 'build', pass: true, ms: 10 }],
        }) +
        "'",
      cwd: process.cwd(),
      env: process.env,
    })),
  };
});

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Call = { url: string; method: string; headers: Record<string, string>; body?: string };

function sampleInput(overrides: Partial<VerificationTraceInput> = {}): VerificationTraceInput {
  return {
    id: '11111111-2222-4333-8444-555555555555',
    runId: '2026-11-23/10-00-00_verify_agent-2',
    full: true,
    verification: { status: 'pass', agent_id: 2, total_ms: 10, stages: [{ name: 'build', pass: true, ms: 10 }] },
    startedAtMs: Date.parse('2026-11-23T10:00:00.000Z'),
    finishedAtMs: Date.parse('2026-11-23T10:00:01.000Z'),
    treeHash: 'a'.repeat(40),
    repositoryUrl: 'https://github.com/acme/app.git',
    checkoutPath: '/home/dev/acme/app',
    ...overrides,
  };
}

function resourceKeys(payload: Json): string[] {
  return payload.resourceSpans[0].resource.attributes.map((kv: Json) => kv.key);
}

function spoolFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
  } catch {
    return [];
  }
}

/** A fetch whose answer per URL prefix is set by the test; records every call. */
function scriptedFetch(answer: (url: string) => number | 'refuse') {
  const calls: Call[] = [];
  const impl = jest.fn(async (url: string | URL, init?: RequestInit) => {
    const target = String(url);
    calls.push({
      url: target,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const result = answer(target);
    if (result === 'refuse') throw new Error('connect ECONNREFUSED');
    return new Response('{}', { status: result });
  });
  return { calls, impl: impl as unknown as typeof fetch, mock: impl };
}

describe('deliverVerificationTrace', () => {
  const saved = { telemetry: process.env.HAR_TELEMETRY };
  let env: NodeJS.ProcessEnv;
  let spoolDir: string;

  beforeEach(() => {
    process.env.HAR_TELEMETRY = 'full';
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'har-vtd-'));
    spoolDir = path.join(home, 'spool');
    env = { HAR_DESTINATIONS_DIR: path.join(home, 'destinations'), [TELEMETRY_SPOOL_DIR_ENV]: spoolDir };
    writeTelemetryDestinations(
      {
        version: 1,
        destinations: [
          buildLangfuseDestination({ name: 'langfuse', host: 'https://lf.test', publicKey: 'pk-lf', secretKey: LANGFUSE_SECRET }),
          buildOtlpDestination({ name: 'collector', endpoint: 'http://collector.test:4318', includeLocalPaths: true }),
        ],
      },
      env,
    );
  });
  afterEach(() => {
    if (saved.telemetry === undefined) delete process.env.HAR_TELEMETRY;
    else process.env.HAR_TELEMETRY = saved.telemetry;
  });

  /** Spans each receiver was sent, by trace and span id. */
  function spansByReceiver(calls: Call[]): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const call of calls.filter((c) => c.method === 'POST')) {
      const receiver = call.url.startsWith(CONTROL) ? 'mission-control' : new URL(call.url).host;
      const body = JSON.parse(call.body!) as Json;
      for (const span of body.resourceSpans[0].scopeSpans[0].spans as Json[]) {
        (out[receiver] ??= []).push(`${span.traceId}/${span.spanId}`);
      }
    }
    return out;
  }

  it('everything up: one copy to Mission Control and one to each destination, nothing spooled', async () => {
    const net = scriptedFetch(() => 200);
    const result = await deliverVerificationTrace(() => sampleInput(), {
      env,
      fetchImpl: net.impl,
      controlApiUrl: CONTROL,
      controlReachable: async () => true,
    });
    expect(result).toEqual({
      spanExport: { destinations: 2, failed: [] },
      delivery: { via: 'fanout', delivered: ['mission-control', 'langfuse', 'collector'], spooled: 0 },
    });
    expect(net.calls.map((call) => call.url).sort()).toEqual(
      [`${CONTROL}/api/otel/v1/traces`, 'http://collector.test:4318/v1/traces', 'https://lf.test/api/public/otel/v1/traces'].sort(),
    );
    const toControl = net.calls.find((call) => call.url.startsWith(CONTROL))!;
    // Mission Control needs the checkout path to attribute the run; destinations never get it.
    expect(resourceKeys(JSON.parse(toControl.body!) as Json)).toContain('factory.local.checkout_path');
    // Asks a Mission Control from 2.0.0-next.3 or earlier, which still forwards, not to.
    expect(toControl.headers[CONTROL_SKIP_FORWARD_HEADER]).toBe('skip');
    expect(spoolFiles(spoolDir)).toHaveLength(0);
  });

  it('Mission Control answering an error: only its copy is spooled, the destinations still get theirs', async () => {
    const net = scriptedFetch((url) => (url.startsWith(CONTROL) ? 503 : 200));
    const result = await deliverVerificationTrace(() => sampleInput(), {
      env,
      fetchImpl: net.impl,
      controlApiUrl: CONTROL,
      controlReachable: async () => true,
    });
    expect(result.delivery).toEqual({ via: 'fanout', delivered: ['langfuse', 'collector'], spooled: 1 });
    expect(result.spanExport).toEqual({ destinations: 2, failed: [] });
    const [entry] = spoolFiles(spoolDir).map((name) => JSON.parse(fs.readFileSync(path.join(spoolDir, name), 'utf8')) as Json);
    expect(entry.target).toEqual({ kind: 'control' });
    expect(entry.lastError).toBe('HTTP 503');
  });

  it('direct sends strip factory.local.* for every destination', async () => {
    const net = scriptedFetch(() => 200);
    await deliverVerificationTrace(() => sampleInput(), { env, fetchImpl: net.impl, controlApiUrl: false });
    expect(net.calls.map((call) => call.url).sort()).toEqual([
      'http://collector.test:4318/v1/traces',
      'https://lf.test/api/public/otel/v1/traces',
    ]);
    for (const call of net.calls) {
      expect(call.body).not.toContain('factory.local.');
      expect(call.body).not.toContain('/home/dev/acme/app');
    }
  });

  it('Mission Control down and one destination failing: one spool entry per missed receiver, each delivered exactly once', async () => {
    const down = scriptedFetch((url) => (url.startsWith('https://lf.test') ? 'refuse' : 200));
    const result = await deliverVerificationTrace(() => sampleInput(), {
      env,
      fetchImpl: down.impl,
      controlApiUrl: CONTROL,
      controlReachable: async () => false,
    });
    expect(result.spanExport).toEqual({ destinations: 2, failed: ['langfuse'] });
    // Langfuse's copy, and Mission Control's.
    expect(result.delivery).toEqual({ via: 'fanout', delivered: ['collector'], spooled: 2 });
    expect(down.calls.some((call) => call.url.startsWith(CONTROL))).toBe(false);
    expect(spoolFiles(spoolDir)).toHaveLength(2);
    expect(summarizeTelemetrySpool(env).map((entry) => [entry.receiver, entry.batches, entry.lastError]).sort()).toEqual([
      ['langfuse', 1, 'ECONNREFUSED'],
      ['mission-control', 1, 'not reachable'],
    ]);

    // The spool never holds header values or local paths.
    for (const name of spoolFiles(spoolDir)) {
      const raw = fs.readFileSync(path.join(spoolDir, name), 'utf8');
      expect(raw).not.toContain(LANGFUSE_SECRET);
      expect(raw).not.toContain(Buffer.from(`pk-lf:${LANGFUSE_SECRET}`).toString('base64'));
      expect(raw).not.toContain('Authorization');
      expect(raw).not.toContain('factory.local.');
      expect(raw).not.toContain('/home/dev/acme/app');
      expect((fs.statSync(path.join(spoolDir, name)).mode & 0o777).toString(8)).toBe('600');
    }

    // Langfuse is back, Mission Control still down: Langfuse's copy goes, with its current header.
    const back = scriptedFetch(() => 200);
    const first = await flushVerificationTraceSpool({
      env,
      fetchImpl: back.impl,
      controlApiUrl: CONTROL,
      controlReachable: async () => false,
    });
    expect(first).toEqual({ sent: 1, retried: 0, dropped: 0, pending: 1 });
    expect(back.calls).toHaveLength(1);
    expect(back.calls[0].url).toBe('https://lf.test/api/public/otel/v1/traces');
    expect(back.calls[0].headers.Authorization).toMatch(/^Basic /);

    // Mission Control is up: its own copy, and nothing for anyone else.
    const up = scriptedFetch(() => 200);
    const second = await flushVerificationTraceSpool({
      env,
      fetchImpl: up.impl,
      controlApiUrl: CONTROL,
      controlReachable: async () => true,
    });
    expect(second).toEqual({ sent: 1, retried: 0, dropped: 0, pending: 0 });
    expect(up.calls.map((call) => call.url)).toEqual([`${CONTROL}/api/otel/v1/traces`]);
    expect(up.calls[0].headers[CONTROL_SKIP_FORWARD_HEADER]).toBe('skip');
    expect(spoolFiles(spoolDir)).toHaveLength(0);

    // A further flush sends nothing: every receiver has the trace exactly once.
    const again = scriptedFetch(() => 200);
    await flushVerificationTraceSpool({ env, fetchImpl: again.impl, controlApiUrl: CONTROL, controlReachable: async () => true });
    expect(again.calls).toHaveLength(0);
    const expected = (buildVerificationTrace(sampleInput()) as Json).resourceSpans[0].scopeSpans[0].spans.map(
      (span: Json) => `${span.traceId}/${span.spanId}`,
    );
    // Accepted copies only: Langfuse refused the first attempt.
    const accepted = down.calls.filter((call) => !call.url.startsWith('https://lf.test'));
    const received = spansByReceiver([...accepted, ...back.calls, ...up.calls]);
    expect(received).toEqual({ 'collector.test:4318': expected, 'lf.test': expected, 'mission-control': expected });
  });

  it('nothing configured and no Mission Control: nothing built, nothing spooled', async () => {
    fs.rmSync(env.HAR_DESTINATIONS_DIR!, { recursive: true, force: true });
    const resolve = jest.fn(() => sampleInput());
    const net = scriptedFetch(() => 200);
    expect(await deliverVerificationTrace(resolve, { env, fetchImpl: net.impl, controlApiUrl: false })).toEqual({});
    expect(resolve).not.toHaveBeenCalled();
    expect(net.calls).toHaveLength(0);
  });

  it('telemetry off: no delivery at all', async () => {
    process.env.HAR_TELEMETRY = 'off';
    const net = scriptedFetch(() => 200);
    expect(
      await deliverVerificationTrace(() => sampleInput(), {
        env,
        fetchImpl: net.impl,
        controlApiUrl: CONTROL,
        controlReachable: async () => true,
      }),
    ).toEqual({});
    expect(net.calls).toHaveLength(0);
  });
});

describe('telemetry spool bounds', () => {
  let env: NodeJS.ProcessEnv;
  let spoolDir: string;
  const payload = buildVerificationTrace(sampleInput());

  beforeEach(() => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'har-spool-'));
    spoolDir = path.join(home, 'spool');
    env = { HAR_DESTINATIONS_DIR: path.join(home, 'destinations'), [TELEMETRY_SPOOL_DIR_ENV]: spoolDir };
    writeTelemetryDestinations(
      { version: 1, destinations: [buildOtlpDestination({ name: 'col', endpoint: 'http://col.test:4318' })] },
      env,
    );
  });

  it('drops entries past the age cap, for removed destinations, and on a non-retryable status', async () => {
    const t0 = Date.parse('2026-11-23T00:00:00Z');
    spoolOtlpPayload({ kind: 'destination', name: 'col' }, payload, [], { env, now: () => t0 });
    spoolOtlpPayload({ kind: 'destination', name: 'gone' }, payload, [], { env, now: () => t0 + 1 });
    const old = await flushTelemetrySpool({ env, now: () => t0 + 25 * 60 * 60_000, fetchImpl: scriptedFetch(() => 200).impl });
    expect(old).toEqual({ sent: 0, retried: 0, dropped: 2, pending: 0 });

    spoolOtlpPayload({ kind: 'destination', name: 'col' }, payload, [], { env });
    const rejected = await flushTelemetrySpool({ env, fetchImpl: scriptedFetch(() => 400).impl });
    expect(rejected.dropped).toBe(1);
    expect(spoolFiles(spoolDir)).toHaveLength(0);
  });

  it('backs off a retryable failure and keeps the oldest entries out under the byte cap', async () => {
    spoolOtlpPayload({ kind: 'destination', name: 'col' }, payload, [], { env });
    const failed = await flushTelemetrySpool({ env, fetchImpl: scriptedFetch(() => 503).impl });
    expect(failed).toEqual({ sent: 0, retried: 1, dropped: 0, pending: 0 });
    const notDue = await flushTelemetrySpool({ env, fetchImpl: scriptedFetch(() => 200).impl });
    expect(notDue).toEqual({ sent: 0, retried: 0, dropped: 0, pending: 1 });

    const size = fs.statSync(path.join(spoolDir, spoolFiles(spoolDir)[0])).size;
    for (let i = 0; i < 3; i++) spoolOtlpPayload({ kind: 'destination', name: 'col' }, payload, [], { env, maxBytes: size * 2 + 10 });
    expect(spoolFiles(spoolDir)).toHaveLength(2);
  });

  it('a flush with an empty spool makes no request', async () => {
    const net = scriptedFetch(() => 200);
    expect(await flushTelemetrySpool({ env, fetchImpl: net.impl, controlApiUrl: CONTROL })).toEqual({
      sent: 0,
      retried: 0,
      dropped: 0,
      pending: 0,
    });
    expect(net.calls).toHaveLength(0);
  });
});

describe('runVerification routes the trace', () => {
  const saved = {
    telemetry: process.env.HAR_TELEMETRY,
    control: process.env.HAR_CONTROL_API_URL,
    spool: process.env[TELEMETRY_SPOOL_DIR_ENV],
    route: process.env[VERIFICATION_TRACE_CONTROL_TEST_ENV],
  };
  let fetchSpy: jest.SpyInstance;
  let spoolDir: string;

  beforeEach(() => {
    process.env.HAR_TELEMETRY = 'full';
    process.env.HAR_CONTROL_API_URL = CONTROL;
    process.env[VERIFICATION_TRACE_CONTROL_TEST_ENV] = 'on';
    spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-vtd-spool-'));
    process.env[TELEMETRY_SPOOL_DIR_ENV] = spoolDir;
    fs.rmSync(process.env.HAR_DESTINATIONS_DIR!, { recursive: true, force: true });
    writeTelemetryDestinations({
      version: 1,
      destinations: [buildOtlpDestination({ name: 'col', endpoint: 'http://col.test:4318' })],
    });
  });
  afterEach(() => {
    fetchSpy?.mockRestore();
    fs.rmSync(process.env.HAR_DESTINATIONS_DIR!, { recursive: true, force: true });
    for (const [name, value] of [
      ['HAR_TELEMETRY', saved.telemetry],
      ['HAR_CONTROL_API_URL', saved.control],
      [TELEMETRY_SPOOL_DIR_ENV, saved.spool],
      [VERIFICATION_TRACE_CONTROL_TEST_ENV, saved.route],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  function initHarnessRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-vtd-repo-'));
    fs.cpSync(path.join(FIXTURE, '.har'), path.join(dir, '.har'), { recursive: true });
    const sh = (command: string) => execSync(command, { cwd: dir, stdio: 'pipe' });
    sh('git init -q -b main');
    sh('git config user.email har@test.local');
    sh('git config user.name har');
    sh('git remote add origin https://github.com/acme/app.git');
    fs.writeFileSync(path.join(dir, 'app.txt'), 'v1\n');
    sh('git add -A');
    sh('git commit -q -m init');
    return dir;
  }

  function urls(): string[] {
    return fetchSpy.mock.calls.map((call) => String(call[0]));
  }

  it('Mission Control up: one POST to it and one to the destination', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
    const result = await runVerification({ repoPath: initHarnessRepo(), agentId: 1, full: true, capture: true });
    expect(result.traceDelivery).toEqual({ via: 'fanout', delivered: ['mission-control', 'col'], spooled: 0 });
    expect(result.spanExport).toEqual({ destinations: 1, failed: [] });
    expect(urls().sort()).toEqual(
      [`${CONTROL}/api/health`, `${CONTROL}/api/otel/v1/traces`, 'http://col.test:4318/v1/traces'].sort(),
    );
  });

  it('carries the verify policy on the run span, as the proof predicate names it', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
    const repo = initHarnessRepo();
    await runVerification({ repoPath: repo, agentId: 1, full: true, capture: true });
    const post = fetchSpy.mock.calls.find((call) => String(call[0]) === 'http://col.test:4318/v1/traces')!;
    const runSpan = (JSON.parse(String((post[1] as RequestInit).body)) as Json).resourceSpans[0].scopeSpans[0].spans[0];
    const attr = (key: string) => runSpan.attributes.find((kv: Json) => kv.key === key)?.value.stringValue;
    const digest = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(repo, '.har', 'stages.json'))).digest('hex'); // eslint-disable-line @typescript-eslint/no-require-imports
    expect(attr('factory.policy.id')).toBe('har-verify-full');
    expect(attr('factory.policy.digest')).toBe(digest);
  });

  it('everything down: spooled per receiver, then delivered by the next verify, exactly once each', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED'));
    const repo = initHarnessRepo();
    const first = await runVerification({ repoPath: repo, agentId: 1, full: true, capture: true });
    expect(first.spanExport).toEqual({ destinations: 1, failed: ['col'] });
    expect(first.traceDelivery).toEqual({ via: 'fanout', delivered: [], spooled: 2 });
    expect(spoolFiles(spoolDir)).toHaveLength(2);
    const firstTrace = (JSON.parse(String((fetchSpy.mock.calls.find((call) => String(call[0]).startsWith('http://col.test'))![1] as RequestInit).body)) as Json)
      .resourceSpans[0].scopeSpans[0].spans[0].spanId;
    fetchSpy.mockRestore();

    // Everything is back: the next verify flushes both queued copies first, then fans its own trace out.
    fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
    const second = await runVerification({ repoPath: repo, agentId: 1, full: true, capture: true });
    expect(second.traceDelivery).toEqual({ via: 'fanout', delivered: ['mission-control', 'col'], spooled: 0 });
    expect(spoolFiles(spoolDir)).toHaveLength(0);
    const posts = fetchSpy.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
    const runSpanIds = (calls: typeof posts) =>
      calls.map((call) => (JSON.parse(String((call[1] as RequestInit).body)) as Json).resourceSpans[0].scopeSpans[0].spans[0].spanId as string);
    const toDestination = posts.filter((call) => String(call[0]) === 'http://col.test:4318/v1/traces');
    const toControl = posts.filter((call) => String(call[0]) === `${CONTROL}/api/otel/v1/traces`);
    // Each receiver: the earlier run once (from the spool) and this run once.
    expect(runSpanIds(toDestination)).toHaveLength(2);
    expect(runSpanIds(toControl)).toHaveLength(2);
    expect(runSpanIds(toDestination)[0]).toBe(firstTrace);
    expect(new Set(runSpanIds(toDestination)).size).toBe(2);
    expect(runSpanIds(toControl).sort()).toEqual(runSpanIds(toDestination).sort());
    for (const call of toControl) {
      expect((call[1] as RequestInit).headers).toMatchObject({ [CONTROL_SKIP_FORWARD_HEADER]: 'skip' });
    }
  });
});
