/**
 * Outward OpenTelemetry contracts (#416).
 *
 * HAR 2.0 replaced every `har.*` attribute with OTel semantic-convention and
 * Factory Commits telemetry-profile names (a documented major-version break).
 * Mission Control reads the session Resource attributes HAR writes into
 * `OTEL_RESOURCE_ATTRIBUTES`, and the otel-hook exports to the Mission Control
 * OTLP routes below. These names are the 2.0 contract: rename or remove one
 * only in a major version, and never bring a `har.*` key back.
 *
 * Assertions allow additions ("contains at least these keys") and use exact
 * equality only where the value itself is the contract (a route, an encoding
 * rule, a pinned package).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildOtelHooksConfig,
  OTEL_HOOKS_PACKAGE,
  OTEL_HOOKS_PACKAGE_ENV,
  otelHooksPackageSpec,
  parseResourceAttributesString,
} from '../src/core/otel-hooks';
import { writeTelemetryLevel } from '../src/core/telemetry-config';
import { buildTestPayload } from '../src/core/telemetry-destinations';
import {
  buildOtelResourceAttributes,
  buildTelemetryEnvBlock,
  type TelemetrySessionAttrs,
} from '../src/core/telemetry-env';
import { buildVerificationTrace } from '../src/core/verification-spans';

/** Session Resource keys HAR 2.0 writes for every launched agent. */
const SESSION_RESOURCE_KEYS = [
  'session.id',
  'factory.local.checkout_path',
  'factory.local.work_dir',
  'vcs.ref.head.name',
  'factory.producer.name',
];

/**
 * Work identity HAR never puts in an agent's environment (ADR 0004 section 3):
 * otel-hook stamps it from the session context, segment by segment.
 */
const WORK_IDENTITY_KEYS = ['factory.slot.id', 'factory.work_unit.id', 'factory.work_unit.source', 'factory.attempt.id'];

const FULL_ATTRS: TelemetrySessionAttrs = {
  sessionKey: 'main-abcd-har-agent-1-xy12',
  agentId: 1,
  repoPath: '/repo',
  workDir: '/repo/wt',
  branch: 'main-abcd-har-agent-1-xy12',
  suffix: 'xy12',
  workUnitId: 'ISSUE-416',
  attemptId: '11111111-1111-4111-8111-111111111111',
  repositoryUrl: 'https://github.com/acme/app.git',
  workUnitSource: 'github',
  producerVersion: '2.0.0',
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

/** Every attribute key, metric, scope and span name anywhere in an OTLP/JSON payload. */
function otlpNames(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) otlpNames(item, out);
  } else if (node && typeof node === 'object') {
    for (const [field, value] of Object.entries(node)) {
      if ((field === 'key' || field === 'name') && typeof value === 'string') out.push(value);
      otlpNames(value, out);
    }
  }
  return out;
}

describe('OTEL_RESOURCE_ATTRIBUTES contract (#416)', () => {
  it('carries the session, local paths and repository keys, and no work identity', () => {
    const attrs = decode(buildOtelResourceAttributes(FULL_ATTRS));
    expect(Object.keys(attrs)).toEqual(expect.arrayContaining(SESSION_RESOURCE_KEYS));
    expect(attrs).toMatchObject({
      'session.id': 'main-abcd-har-agent-1-xy12',
      'factory.local.checkout_path': '/repo',
      'factory.local.work_dir': '/repo/wt',
      'vcs.ref.head.name': 'main-abcd-har-agent-1-xy12',
      'vcs.repository.url.full': 'https://github.com/acme/app.git',
      'factory.producer.name': 'har',
      'factory.producer.version': '2.0.0',
    });
    for (const key of WORK_IDENTITY_KEYS) expect(Object.keys(attrs)).not.toContain(key);
  });

  it('emits no har.* key (removed in 2.0)', () => {
    const keys = Object.keys(decode(buildOtelResourceAttributes(FULL_ATTRS)));
    expect(keys.filter((key) => key.startsWith('har.'))).toEqual([]);
    // The slot suffix has no reader; it is not emitted under any name.
    expect(keys.some((key) => key.includes('suffix'))).toBe(false);
  });

  it('puts absolute paths only under the local-only factory.local.* namespace', () => {
    const attrs = decode(buildOtelResourceAttributes(FULL_ATTRS));
    const pathKeys = Object.entries(attrs)
      .filter(([, value]) => value.startsWith('/'))
      .map(([key]) => key);
    expect(pathKeys.sort()).toEqual(['factory.local.checkout_path', 'factory.local.work_dir']);
  });

  it('always carries the session identity, and omits optional keys when unknown', () => {
    const attrs = decode(
      buildOtelResourceAttributes({
        sessionKey: 's1',
        agentId: 2,
        repoPath: '/r',
        workDir: '/r',
        producerVersion: '2.0.0',
      }),
    );
    expect(attrs).toMatchObject({
      'session.id': 's1',
      'factory.local.checkout_path': '/r',
      'factory.local.work_dir': '/r',
    });
    for (const key of ['vcs.ref.head.name', ...WORK_IDENTITY_KEYS]) {
      expect(Object.keys(attrs)).not.toContain(key);
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
    expect(attrs['session.id']).toBe('a_b_c');
    expect(attrs['factory.local.checkout_path']).toBe('/repo_x');
    expect(attrs['factory.local.work_dir']).toBe('/wt_y');
    expect(attrs['vcs.ref.head.name']).toBe('feat/a_b');
    // The otel-hook config reader parses the same encoding back.
    expect(parseResourceAttributesString(raw)).toMatchObject(attrs);
  });

  it('is written to the agent env file as OTEL_RESOURCE_ATTRIBUTES, with no HAR_SESSION_KEY', () => {
    const block = buildTelemetryEnvBlock(FULL_ATTRS);
    const line = block.split('\n').find((l) => l.startsWith('OTEL_RESOURCE_ATTRIBUTES='));
    expect(line).toBeDefined();
    const value = (line as string).slice('OTEL_RESOURCE_ATTRIBUTES='.length).replace(/^'|'$/g, '');
    expect(Object.keys(decode(value))).toEqual(
      expect.arrayContaining(SESSION_RESOURCE_KEYS.filter((key) => !key.startsWith('factory.local.'))),
    );
    // Stripped unless every destination opts in to local paths.
    expect(value).not.toContain('factory.local.');
    for (const key of WORK_IDENTITY_KEYS) expect(value).not.toContain(`${key}=`);
    for (const name of ['HAR_WORK_UNIT_ID', 'HAR_ATTEMPT_ID', 'HAR_CONTROL_API_URL']) {
      expect(block).toMatch(new RegExp(`^${name}=`, 'm'));
    }
    // Claude Code strips OTEL_* from hooks (#484): the wrapper restores this copy.
    expect(block).toContain(`\nHAR_RESOURCE_ATTRIBUTES=${(line as string).slice('OTEL_RESOURCE_ATTRIBUTES='.length)}\n`);
    // otel-hook <= 0.6 turns HAR_SESSION_KEY into a `har.session_key` attribute.
    expect(block).not.toMatch(/^HAR_SESSION_KEY=/m);
    expect(block).not.toMatch(/\bhar\.[a-z_]/);
  });
});

describe('HAR-built OTLP payloads (#416)', () => {
  it('verification spans use the @osfactory/har scope and no har.* name', () => {
    const payload = buildVerificationTrace({
      id: 'v-1',
      runId: 'r-1',
      full: true,
      verification: { status: 'pass', agent_id: 1, total_ms: 1, stages: [{ name: 'build', pass: true, ms: 1 }] },
      startedAtMs: 0,
      finishedAtMs: 1,
      treeHash: 'a'.repeat(40),
      workUnitId: 'W-1',
      attemptId: 'a-1',
      branch: 'b',
      producerVersion: '2.0.0',
    });
    const names = otlpNames(payload);
    expect(names).toContain('@osfactory/har');
    expect(names.filter((name) => name.startsWith('har.'))).toEqual([]);
  });

  it('destination test payloads use no har.* name', () => {
    for (const signal of ['traces', 'logs', 'metrics'] as const) {
      const names = otlpNames(buildTestPayload(signal, 0));
      expect(names).toContain('@osfactory/har');
      expect(names.filter((name) => name.startsWith('har.'))).toEqual([]);
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

  it('pins the otel-hook package, overridable for an unreleased build', () => {
    expect(OTEL_HOOKS_PACKAGE).toBe('@osfactory/otel-hook@0.12.0');
    expect(OTEL_HOOKS_PACKAGE_ENV).toBe('HAR_OTEL_HOOKS_PACKAGE');
    expect(otelHooksPackageSpec({})).toBe(OTEL_HOOKS_PACKAGE);
    expect(otelHooksPackageSpec({ HAR_OTEL_HOOKS_PACKAGE: ' /tmp/otel-hook.tgz ' })).toBe('/tmp/otel-hook.tgz');
    expect(otelHooksPackageSpec({ HAR_OTEL_HOOKS_PACKAGE: '' })).toBe(OTEL_HOOKS_PACKAGE);
  });

  it('exports traces and logs to the Mission Control OTLP routes over http/protobuf', () => {
    writeTelemetryLevel('full');
    const config = buildOtelHooksConfig({ apiUrl: 'http://localhost:3847/' });
    // Mission Control is one entry of the destination list (fan-out at the producer).
    expect(config.exporter.destinations).toEqual([
      expect.objectContaining({
        name: 'mission-control',
        tracesEndpoint: 'http://localhost:3847/api/otel/v1/traces',
        logsEndpoint: 'http://localhost:3847/api/otel/v1/logs',
      }),
    ]);
    expect(config.exporter.protocol).toBe('http/protobuf');
    expect(config.exporter.serviceName).toBe('har-ide-agent');
  });

  it('passes OTEL_RESOURCE_ATTRIBUTES through as exporter resource attributes', () => {
    writeTelemetryLevel('full');
    const config = buildOtelHooksConfig({
      apiUrl: 'http://localhost:3847',
      resourceAttributes: buildOtelResourceAttributes(FULL_ATTRS),
    });
    // factory.local.* is stripped: Mission Control did not opt in to local paths.
    expect(Object.keys(config.exporter.resourceAttributes ?? {})).toEqual(
      expect.arrayContaining(SESSION_RESOURCE_KEYS.filter((key) => !key.startsWith('factory.local.'))),
    );
    expect(Object.keys(config.exporter.resourceAttributes ?? {}).some((key) => key.startsWith('factory.local.'))).toBe(false);
  });
});
