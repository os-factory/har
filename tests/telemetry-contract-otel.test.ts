/**
 * Outward OpenTelemetry contracts — guards for the HAR 2.0 non-breaking rule (#416).
 *
 * Mission Control, HQ and existing dashboards read the `har.*` resource
 * attributes HAR writes into `OTEL_RESOURCE_ATTRIBUTES`, and the otel-hook
 * exports to the Mission Control OTLP routes below. HAR 2.0 may add attributes
 * and routes; it must not rename or remove these.
 *
 * Assertions allow additions ("contains at least these keys") and use exact
 * equality only where the value itself is the contract (a route, an encoding
 * rule, a pinned package). If one fails, add the new shape alongside the old
 * one instead of editing the expectation.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildClaudeNativeTelemetryEnv } from '../src/core/claude-native-telemetry';
import { buildOtelHooksConfig, OTEL_HOOKS_PACKAGE, parseResourceAttributesString } from '../src/core/otel-hooks';
import { writeTelemetryLevel } from '../src/core/telemetry-config';
import {
  buildOtelResourceAttributes,
  buildTelemetryEnvBlock,
  type TelemetrySessionAttrs,
} from '../src/core/telemetry-env';

const HAR_RESOURCE_KEYS = [
  'har.session_key',
  'har.agent_id',
  'har.repo_path',
  'har.work_dir',
  'har.branch',
  'har.suffix',
  'har.work_unit_id',
  'har.attempt_id',
];

const FULL_ATTRS: TelemetrySessionAttrs = {
  sessionKey: 'main-abcd-har-agent-1-xy12',
  agentId: 1,
  repoPath: '/repo',
  workDir: '/repo/wt',
  branch: 'main-abcd-har-agent-1-xy12',
  suffix: 'xy12',
  workUnitId: 'ISSUE-416',
  attemptId: '11111111-1111-4111-8111-111111111111',
};

/** Decode `k=v,k=v` the way a consumer splits it: on every comma, then the first `=`. */
function decode(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const eq = part.indexOf('=');
    out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

describe('OTEL_RESOURCE_ATTRIBUTES contract (#416)', () => {
  it('carries every har.* key with its value', () => {
    const attrs = decode(buildOtelResourceAttributes(FULL_ATTRS));
    expect(Object.keys(attrs)).toEqual(expect.arrayContaining(HAR_RESOURCE_KEYS));
    expect(attrs).toMatchObject({
      'har.session_key': 'main-abcd-har-agent-1-xy12',
      'har.agent_id': '1',
      'har.repo_path': '/repo',
      'har.work_dir': '/repo/wt',
      'har.branch': 'main-abcd-har-agent-1-xy12',
      'har.suffix': 'xy12',
      'har.work_unit_id': 'ISSUE-416',
      'har.attempt_id': '11111111-1111-4111-8111-111111111111',
    });
  });

  it('always carries the session identity, and omits optional keys when unknown', () => {
    const attrs = decode(
      buildOtelResourceAttributes({ sessionKey: 's1', agentId: 2, repoPath: '/r', workDir: '/r' }),
    );
    expect(attrs).toMatchObject({
      'har.session_key': 's1',
      'har.agent_id': '2',
      'har.repo_path': '/r',
      'har.work_dir': '/r',
    });
    for (const key of ['har.branch', 'har.suffix', 'har.work_unit_id', 'har.attempt_id']) {
      expect(attrs).not.toHaveProperty(key);
    }
    expect(Object.values(attrs)).not.toContain('');
  });

  it('is a comma-separated list of key=value pairs with , and = in values replaced by _', () => {
    const raw = buildOtelResourceAttributes({
      sessionKey: 'a,b=c',
      agentId: 1,
      repoPath: '/repo,x',
      workDir: '/wt=y',
      branch: 'feat/a,b',
    });
    const attrs = decode(raw);
    expect(attrs['har.session_key']).toBe('a_b_c');
    expect(attrs['har.repo_path']).toBe('/repo_x');
    expect(attrs['har.work_dir']).toBe('/wt_y');
    expect(attrs['har.branch']).toBe('feat/a_b');
    // The otel-hook config reader parses the same encoding back.
    expect(parseResourceAttributesString(raw)).toMatchObject(attrs);
  });

  it('is written to the agent env file as OTEL_RESOURCE_ATTRIBUTES', () => {
    const block = buildTelemetryEnvBlock(FULL_ATTRS);
    const line = block.split('\n').find((l) => l.startsWith('OTEL_RESOURCE_ATTRIBUTES='));
    expect(line).toBeDefined();
    const value = (line as string).slice('OTEL_RESOURCE_ATTRIBUTES='.length).replace(/^'|'$/g, '');
    expect(Object.keys(decode(value))).toEqual(expect.arrayContaining(HAR_RESOURCE_KEYS));
    for (const name of ['HAR_SESSION_KEY', 'HAR_WORK_UNIT_ID', 'HAR_ATTEMPT_ID', 'HAR_CONTROL_API_URL']) {
      expect(block).toMatch(new RegExp(`^${name}=`, 'm'));
    }
  });
});

describe('otel-hook exporter contract (#416)', () => {
  const originalPath = process.env.HAR_TELEMETRY_CONFIG_PATH;
  const originalTelemetry = process.env.HAR_TELEMETRY;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-otel-contract-'));
    process.env.HAR_TELEMETRY_CONFIG_PATH = path.join(tmpDir, 'telemetry.json');
    delete process.env.HAR_TELEMETRY;
  });

  afterEach(() => {
    if (originalPath === undefined) delete process.env.HAR_TELEMETRY_CONFIG_PATH;
    else process.env.HAR_TELEMETRY_CONFIG_PATH = originalPath;
    if (originalTelemetry === undefined) delete process.env.HAR_TELEMETRY;
    else process.env.HAR_TELEMETRY = originalTelemetry;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('pins the otel-hook package', () => {
    expect(OTEL_HOOKS_PACKAGE).toBe('@osfactory/otel-hook@0.6.0');
  });

  it('exports traces and logs to the Mission Control OTLP routes over http/protobuf', () => {
    writeTelemetryLevel('full');
    const config = buildOtelHooksConfig({ apiUrl: 'http://localhost:3847/' });
    expect(config.exporter.endpoint).toBe('http://localhost:3847/api/otel/v1/traces');
    expect(config.exporter.logs.endpoint).toBe('http://localhost:3847/api/otel/v1/logs');
    expect(config.exporter.protocol).toBe('http/protobuf');
    expect(config.exporter.serviceName).toBe('har-ide-agent');
  });

  it('passes OTEL_RESOURCE_ATTRIBUTES through as exporter resource attributes', () => {
    writeTelemetryLevel('full');
    const config = buildOtelHooksConfig({
      apiUrl: 'http://localhost:3847',
      resourceAttributes: buildOtelResourceAttributes(FULL_ATTRS),
    });
    expect(Object.keys(config.exporter.resourceAttributes ?? {})).toEqual(
      expect.arrayContaining(HAR_RESOURCE_KEYS),
    );
  });

  it('points Claude Code native metrics and logs at the same OTLP routes', () => {
    const env = buildClaudeNativeTelemetryEnv('http://localhost:3847/');
    expect(env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe('http://localhost:3847/api/otel/v1/metrics');
    expect(env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT).toBe('http://localhost:3847/api/otel/v1/logs');
  });
});
