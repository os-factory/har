import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatDoctorReport, type DoctorReport } from '../src/harness/doctor';
import { writeTelemetryLevel } from '../src/core/telemetry-config';
import {
  assessTelemetryHealth,
  collectTelemetryHealth,
  formatAgo,
  runOtelHookDoctor,
  withTelemetryHealth,
} from '../src/core/telemetry-health';
import { spoolOtlpPayload, TELEMETRY_SPOOL_DIR_ENV } from '../src/core/telemetry-spool';

const NOW = Date.parse('2026-11-25T12:00:00.000Z');
const MIN = 60_000;

/** `otel-hook doctor --json` (0.9.0) for a Mission Control entry and a Langfuse entry. */
function doctorReport(langfuse: Record<string, unknown> = {}, missionControl: Record<string, unknown> = {}) {
  const queue = (batches: number, extra: Record<string, unknown> = {}) => ({
    batches,
    bytes: batches * 1000,
    dropped: { total: 0, age: 0, size: 0, count: 0, rejected: 0 },
    ...extra,
  });
  return {
    ok: true,
    version: '0.9.0',
    checks: [],
    destinations: [
      {
        name: 'mission-control',
        enabled: true,
        signals: ['traces', 'logs'],
        headerNames: [],
        headerVariables: [],
        missingVariables: [],
        ok: true,
        spool: { traces: queue(0), logs: queue(0) },
        ...missionControl,
      },
      {
        name: 'langfuse',
        enabled: true,
        signals: ['traces'],
        headerNames: ['Authorization'],
        headerVariables: ['HAR_OTEL_DIRECT_HEADER_1_1'],
        missingVariables: [],
        ok: true,
        spool: { traces: queue(0) },
        ...langfuse,
      },
    ],
  };
}

const empty = { batches: 0, bytes: 0, dropped: { total: 0, age: 0, size: 0, count: 0, rejected: 0 } };

describe('destination health', () => {
  it('passes when every destination is healthy', () => {
    const health = assessTelemetryHealth({ otelHookReport: doctorReport(), spool: [], now: NOW });
    expect(health.status).toBe('pass');
    expect(health.destinations.map((d) => d.summary)).toEqual([
      'mission-control: healthy, nothing queued',
      'langfuse: healthy, nothing queued',
    ]);
  });

  it('warns about queued batches with the last failure and its code', () => {
    const health = assessTelemetryHealth({
      otelHookReport: doctorReport({
        spool: { traces: { ...empty, batches: 7, bytes: 7000, oldestEnqueuedAt: NOW - 30 * MIN } },
        lastFailureAt: NOW - 2 * MIN,
        lastErrorCode: 'ECONNREFUSED',
      }),
      spool: [],
      now: NOW,
    });
    expect(health.status).toBe('warn');
    const langfuse = health.destinations.find((d) => d.name === 'langfuse')!;
    expect(langfuse.status).toBe('warn');
    expect(langfuse.summary).toBe('langfuse: 7 batches queued, last failure 2 min ago (ECONNREFUSED)');
    expect(health.destinations.find((d) => d.name === 'mission-control')!.status).toBe('pass');
  });

  it('reads lastFailureAt / lastErrorCode under health too, and falls back to the oldest queued batch', () => {
    const nested = assessTelemetryHealth({
      otelHookReport: doctorReport({
        spool: { traces: { ...empty, batches: 1 } },
        health: { lastFailureAt: new Date(NOW - 5 * MIN).toISOString(), lastErrorCode: 'HTTP 503' },
      }),
      spool: [],
      now: NOW,
    });
    expect(nested.destinations[1].summary).toBe('langfuse: 1 batch queued, last failure 5 min ago (HTTP 503)');

    // otel-hook 0.9.0 reports no failure time: the age of the oldest queued batch stands in.
    const oldest = assessTelemetryHealth({
      otelHookReport: doctorReport({ spool: { traces: { ...empty, batches: 3, oldestEnqueuedAt: NOW - 3 * 60 * MIN } } }),
      spool: [],
      now: NOW,
    });
    expect(oldest.destinations[1].summary).toBe('langfuse: 3 batches queued, oldest queued 3 h ago');
  });

  it('warns about recent drops by reason, and about a recent failure with nothing queued', () => {
    const health = assessTelemetryHealth({
      otelHookReport: doctorReport(
        {
          spool: {
            traces: { ...empty, dropped: { total: 4, age: 1, size: 0, count: 3, rejected: 0, lastDroppedAt: NOW - 60 * MIN } },
          },
        },
        { lastFailureAt: NOW - 10 * MIN, lastErrorCode: 'timeout' },
      ),
      spool: [],
      now: NOW,
    });
    expect(health.destinations.map((d) => d.summary)).toEqual([
      'mission-control: last failure 10 min ago (timeout)',
      'langfuse: 4 dropped (age 1, count 3)',
    ]);
    expect(health.status).toBe('warn');
  });

  it('ignores old drops and old failures once nothing is queued', () => {
    const health = assessTelemetryHealth({
      otelHookReport: doctorReport(
        { spool: { traces: { ...empty, dropped: { total: 2, age: 2, size: 0, count: 0, rejected: 0, lastDroppedAt: NOW - 3 * 24 * 60 * MIN } } } },
        { lastFailureAt: NOW - 5 * 60 * MIN, lastErrorCode: 'ECONNREFUSED' },
      ),
      spool: [],
      now: NOW,
    });
    expect(health.status).toBe('pass');
  });

  it('merges the CLI verification spool into the same rows, Mission Control included', () => {
    const health = assessTelemetryHealth({
      otelHookReport: doctorReport({ spool: { traces: { ...empty, batches: 2 } } }),
      spool: [
        { receiver: 'langfuse', batches: 1, bytes: 900, lastFailureAt: NOW - 2 * MIN, lastError: 'ECONNREFUSED' },
        { receiver: 'mission-control', batches: 1, bytes: 900, lastFailureAt: NOW - 1 * MIN, lastError: 'not reachable' },
      ],
      now: NOW,
    });
    expect(health.destinations.map((d) => d.summary)).toEqual([
      'mission-control: 1 verification trace queued, last failure 1 min ago (not reachable)',
      'langfuse: 2 batches queued, 1 verification trace queued, last failure 2 min ago (ECONNREFUSED)',
    ]);
  });

  it('maps otel-hook names back to HAR destination names', () => {
    const report = { destinations: [{ name: 'team-collector', spool: { traces: { ...empty, batches: 1 } } }] };
    const health = assessTelemetryHealth({ otelHookReport: report, spool: [], names: new Map([['team-collector', 'Team.Collector']]), now: NOW });
    expect(health.destinations[0].name).toBe('Team.Collector');
  });

  it('names missing header variables, never a value', () => {
    const health = assessTelemetryHealth({
      otelHookReport: doctorReport({ ok: false, missingVariables: ['HAR_OTEL_DIRECT_HEADER_1_1'] }),
      spool: [],
      now: NOW,
    });
    expect(health.destinations[1].summary).toBe('langfuse: header variable(s) not set: HAR_OTEL_DIRECT_HEADER_1_1');
    expect(health.status).toBe('warn');
  });

  it('formats ages', () => {
    expect(formatAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(formatAgo(NOW - 2 * MIN, NOW)).toBe('2 min ago');
    expect(formatAgo(NOW - 3 * 60 * MIN, NOW)).toBe('3 h ago');
    expect(formatAgo(NOW - 3 * 24 * 60 * MIN, NOW)).toBe('3 d ago');
  });
});

describe('collecting destination health', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['HAR_TELEMETRY', 'HAR_TELEMETRY_CONFIG_PATH', 'HAR_OTEL_HOOKS_HOME', TELEMETRY_SPOOL_DIR_ENV, 'HAR_CONTROL_DISABLED'];
  let tmp: string;
  let hooksHome: string;

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-health-'));
    hooksHome = path.join(tmp, 'otel-hooks');
    fs.mkdirSync(hooksHome, { recursive: true });
    delete process.env.HAR_TELEMETRY;
    process.env.HAR_TELEMETRY_CONFIG_PATH = path.join(tmp, 'telemetry.json');
    process.env.HAR_OTEL_HOOKS_HOME = hooksHome;
    process.env[TELEMETRY_SPOOL_DIR_ENV] = path.join(tmp, 'spool');
    process.env.HAR_CONTROL_DISABLED = 'true';
    writeTelemetryLevel('full');
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('skips with a note, never fails, when otel-hook is not installed', () => {
    expect(runOtelHookDoctor(hooksHome)).toEqual({ note: expect.stringContaining('otel-hook is not installed') });
    const health = collectTelemetryHealth({ hooksHome });
    expect(health.status).toBe('pass');
    expect(health.notes).toEqual([expect.stringContaining('otel-hook is not installed')]);
  });

  it('is skipped when telemetry is off', () => {
    writeTelemetryLevel('off');
    expect(collectTelemetryHealth({ hooksHome })).toEqual({ status: 'skip', destinations: [], notes: ['telemetry is off'] });
  });

  it('runs otel-hook doctor --json from the hooks home with the header variables set, and prints none of their values', () => {
    const secret = 'Basic c2VjcmV0LXZhbHVl';
    fs.writeFileSync(path.join(hooksHome, 'direct.env'), `export HAR_OTEL_DIRECT_HEADER_1_1='${secret}'\n`, { mode: 0o600 });
    const bin = path.join(hooksHome, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    // A stand-in that reports the variable as set only when it is, by name, like otel-hook does.
    fs.writeFileSync(
      path.join(bin, 'otel-hook'),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const set = Boolean(process.env.HAR_OTEL_DIRECT_HEADER_1_1);
process.stdout.write(JSON.stringify({ ok: set, cwd: process.cwd(), args, destinations: [{ name: 'langfuse', headerVariables: ['HAR_OTEL_DIRECT_HEADER_1_1'], missingVariables: set ? [] : ['HAR_OTEL_DIRECT_HEADER_1_1'], ok: set, spool: { traces: { batches: 7, bytes: 7000, dropped: { total: 0 } } } }] }));
process.exit(set ? 0 : 1);
`,
      { mode: 0o755 },
    );
    const result = runOtelHookDoctor(hooksHome) as { report: Record<string, unknown> };
    expect(result.report.ok).toBe(true);
    expect(fs.realpathSync(result.report.cwd as string)).toBe(fs.realpathSync(hooksHome));
    expect(result.report.args).toEqual([
      'doctor',
      '--json',
      '--config-file',
      path.join(hooksHome, 'otel_config.json'),
      '--state-dir',
      path.join(hooksHome, 'state'),
    ]);

    const health = collectTelemetryHealth({ hooksHome, now: NOW });
    expect(health.destinations[0]).toMatchObject({ name: 'langfuse', agentQueuedBatches: 7, status: 'warn' });
    expect(JSON.stringify(health)).not.toContain(secret);
  });

  it('adds the CLI verification spool, by receiver', () => {
    spoolOtlpPayload({ kind: 'destination', name: 'langfuse' }, { resourceSpans: [] }, [], { lastError: 'ECONNREFUSED' });
    spoolOtlpPayload({ kind: 'control' }, { resourceSpans: [] }, [], { lastError: 'not reachable' });
    const health = collectTelemetryHealth({ hooksHome, otelHookDoctor: () => ({ report: { destinations: [] } }) });
    expect(health.status).toBe('warn');
    expect(health.destinations.map((d) => [d.name, d.verificationQueued, d.lastErrorCode])).toEqual([
      ['mission-control', 1, 'not reachable'],
      ['langfuse', 1, 'ECONNREFUSED'],
    ]);
  });
});

describe('har env doctor: telemetry-destinations check', () => {
  const report: DoctorReport = {
    ok: true,
    contract: '1.0',
    checks: [{ id: 'harness-env', label: 'harness.env schema', status: 'pass' }],
    findings: [],
  };

  it('passes when everything is healthy', () => {
    const out = withTelemetryHealth(report, { status: 'pass', destinations: [], notes: [] });
    expect(out.checks.at(-1)).toEqual({ id: 'telemetry-destinations', label: 'telemetry destinations', status: 'pass' });
    expect(out.ok).toBe(true);
  });

  it('warns per destination and never fails the contract', () => {
    const health = assessTelemetryHealth({
      otelHookReport: doctorReport({
        spool: { traces: { ...empty, batches: 7 } },
        lastFailureAt: NOW - 2 * MIN,
        lastErrorCode: 'ECONNREFUSED',
      }),
      spool: [],
      now: NOW,
    });
    const out = withTelemetryHealth(report, health);
    expect(out.ok).toBe(true);
    expect(out.checks.at(-1)?.status).toBe('warn');
    expect(out.findings).toEqual([
      expect.objectContaining({
        check: 'telemetry-destinations',
        severity: 'warning',
        message: 'langfuse: 7 batches queued, last failure 2 min ago (ECONNREFUSED)',
      }),
    ]);
    expect(formatDoctorReport(out)).toContain('langfuse: 7 batches queued, last failure 2 min ago (ECONNREFUSED)');
  });

  it('is skipped with its note when otel-hook is missing and telemetry is off', () => {
    const out = withTelemetryHealth(report, { status: 'skip', destinations: [], notes: ['telemetry is off'] });
    expect(out.checks.at(-1)).toEqual({
      id: 'telemetry-destinations',
      label: 'telemetry destinations (telemetry is off)',
      status: 'skip',
    });
  });
});
