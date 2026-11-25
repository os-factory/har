import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  addTelemetryDestination,
  buildLangfuseDestination,
  buildOtlpDestination,
  buildTestPayload,
  getTelemetryDestinationsPath,
  maskTelemetryDestination,
  parseHeaderPairs,
  parseSignals,
  readTelemetryDestinations,
  removeTelemetryDestination,
  testTelemetryDestination,
  OTLP_PRESET_DEFAULT_SIGNALS,
} from '../src/core/telemetry-destinations';
import { buildOtelResourceAttributes } from '../src/core/telemetry-env';
import { destinationFromAddArgs } from '../src/cli/commands/telemetry-destination';
import {
  destinationsForSignal,
  otlpSignalUrl,
  forwardDeniedAttributes,
  telemetryDestinationSchema,
  TELEMETRY_ACCOUNT_IDENTITY_ATTRIBUTES,
  TELEMETRY_FORWARD_DENIED_ATTRIBUTES,
  TELEMETRY_LOCAL_PATH_ATTRIBUTES,
  attributeKeyDenied,
} from '../src/harness/schema';

describe('telemetry destinations', () => {
  let dir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-destinations-'));
    env = { HAR_DESTINATIONS_DIR: path.join(dir, 'destinations') };
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('is empty when nothing is configured', () => {
    expect(readTelemetryDestinations(env)).toEqual({ version: 1, destinations: [] });
    expect(fs.existsSync(getTelemetryDestinationsPath(env))).toBe(false);
  });

  it('persists destinations with mode 0600 in a 0700 directory', () => {
    const destination = buildOtlpDestination({
      name: 'collector',
      endpoint: 'http://localhost:4318',
      headers: { 'x-api-key': 'secret' },
    });
    addTelemetryDestination(destination, { env });
    const filePath = getTelemetryDestinationsPath(env);
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(filePath)).mode & 0o777).toBe(0o700);
    const file = readTelemetryDestinations(env);
    expect(file.destinations).toHaveLength(1);
    expect(file.destinations[0]).toMatchObject({
      name: 'collector',
      endpoint: 'http://localhost:4318',
      protocol: 'http/protobuf',
      headers: { 'x-api-key': 'secret' },
      signals: ['traces', 'metrics'],
      enabled: true,
    });
  });

  it('refuses a duplicate name unless replace is set, then removes it', () => {
    const destination = buildOtlpDestination({ name: 'a', endpoint: 'https://otel.example.com' });
    addTelemetryDestination(destination, { env });
    expect(() => addTelemetryDestination(destination, { env })).toThrow(/already exists/);
    expect(addTelemetryDestination({ ...destination, signals: ['logs'] }, { env, replace: true }).replaced).toBe(true);
    expect(readTelemetryDestinations(env).destinations[0].signals).toEqual(['logs']);
    expect(removeTelemetryDestination('a', env)).toBe(true);
    expect(removeTelemetryDestination('a', env)).toBe(false);
    expect(readTelemetryDestinations(env).destinations).toEqual([]);
  });

  it('builds the Langfuse preset: /api/public/otel, Basic auth, traces only', () => {
    const destination = buildLangfuseDestination({
      name: 'langfuse',
      host: 'https://cloud.langfuse.com/',
      publicKey: 'pk-lf-1',
      secretKey: 'sk-lf-2',
    });
    expect(destination.endpoint).toBe('https://cloud.langfuse.com/api/public/otel');
    expect(destination.headers).toEqual({
      Authorization: `Basic ${Buffer.from('pk-lf-1:sk-lf-2').toString('base64')}`,
    });
    expect(destination.signals).toEqual(['traces']);
    expect(otlpSignalUrl(destination.endpoint, 'traces')).toBe('https://cloud.langfuse.com/api/public/otel/v1/traces');
  });

  it('reads Langfuse keys from the Langfuse env vars and rejects logs or metrics', () => {
    const destination = destinationFromAddArgs(
      { name: 'lf', preset: 'langfuse' },
      { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk', LANGFUSE_HOST: 'https://eu.example.com' },
    );
    expect(destination.endpoint).toBe('https://eu.example.com/api/public/otel');
    expect(() => destinationFromAddArgs({ name: 'lf', preset: 'langfuse' }, {})).toThrow(/public-key/);
    expect(() =>
      destinationFromAddArgs({ name: 'lf', preset: 'langfuse', signals: ['traces,logs'] }, { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' }),
    ).toThrow(/traces only/);
  });

  it('builds the otlp preset from flags', () => {
    const destination = destinationFromAddArgs(
      { name: 'dd', preset: 'otlp', endpoint: 'https://otlp.example.com', header: ['DD-API-KEY=abc=def'], signals: ['traces', 'metrics'] },
      {},
    );
    expect(destination.headers).toEqual({ 'DD-API-KEY': 'abc=def' });
    expect(destination.signals).toEqual(['traces', 'metrics']);
    expect(() => destinationFromAddArgs({ name: 'x', preset: 'otlp' }, {})).toThrow(/--endpoint/);
  });

  it('validates names, endpoints, headers and signals', () => {
    expect(() => parseHeaderPairs(['novalue'])).toThrow(/Name=value/);
    expect(() => parseSignals(['traces,spans'])).toThrow(/Unknown signal/);
    expect(parseSignals(undefined)).toBeUndefined();
    const base = { name: 'ok', endpoint: 'https://otel.example.com', signals: ['traces'] };
    expect(telemetryDestinationSchema.safeParse(base).success).toBe(true);
    expect(telemetryDestinationSchema.safeParse({ ...base, name: 'bad name' }).success).toBe(false);
    expect(telemetryDestinationSchema.safeParse({ ...base, endpoint: 'ftp://x' }).success).toBe(false);
    expect(telemetryDestinationSchema.safeParse({ ...base, endpoint: 'https://u:p@otel.example.com' }).success).toBe(false);
    expect(telemetryDestinationSchema.safeParse({ ...base, signals: [] }).success).toBe(false);
  });

  it('masks header values for display', () => {
    const masked = maskTelemetryDestination(
      buildOtlpDestination({ name: 'a', endpoint: 'https://x.example.com', headers: { Authorization: 'Basic c2VjcmV0', 'x-key': 'secret' } }),
    );
    expect(masked.headers).toEqual({ Authorization: 'Basic ****', 'x-key': '****' });
    expect(JSON.stringify(masked)).not.toContain('secret');
    expect(JSON.stringify(masked)).not.toContain('c2VjcmV0');
  });

  it('selects enabled destinations by signal', () => {
    const file = {
      version: 1 as const,
      destinations: [
        buildOtlpDestination({ name: 'all', endpoint: 'https://a.example.com' }),
        buildOtlpDestination({ name: 'off', endpoint: 'https://b.example.com', enabled: false }),
        buildOtlpDestination({ name: 'logs', endpoint: 'https://c.example.com', signals: ['logs'] }),
      ],
    };
    expect(destinationsForSignal(file, 'traces').map((d) => d.name)).toEqual(['all']);
    expect(destinationsForSignal(file, 'logs').map((d) => d.name)).toEqual(['logs']);
  });

  it('test sends one OTLP/JSON span with the destination headers and reports the status', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    const destination = buildLangfuseDestination({ name: 'lf', publicKey: 'pk', secretKey: 'sk' });
    const result = await testTelemetryDestination(destination, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toMatchObject({ ok: true, status: 200, signal: 'traces', url: 'https://cloud.langfuse.com/api/public/otel/v1/traces' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cloud.langfuse.com/api/public/otel/v1/traces');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers.Authorization).toMatch(/^Basic /);
    const body = JSON.parse(init.body as string) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ traceId: string; spanId: string }> }> }> };
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('test reports failures without the header values', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const destination = buildOtlpDestination({ name: 'x', endpoint: 'https://x.example.com', headers: { 'x-key': 'topsecret' }, signals: ['logs'] });
    const result = await testTelemetryDestination(destination, { fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toMatchObject({ ok: false, status: 401, signal: 'logs', detail: 'unauthorized' });
    expect(JSON.stringify(result)).not.toContain('topsecret');

    const failing = jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED'));
    const down = await testTelemetryDestination(destination, { fetchImpl: failing as unknown as typeof fetch });
    expect(down).toMatchObject({ ok: false, status: null, detail: 'connect ECONNREFUSED' });
  });

  it('builds a payload for every signal', () => {
    expect(buildTestPayload('logs')).toHaveProperty('resourceLogs');
    expect(buildTestPayload('metrics')).toHaveProperty('resourceMetrics');
  });
});

describe('privacy defaults', () => {
  it('the otlp preset forwards traces and metrics; logs only when --signals names them', () => {
    expect(OTLP_PRESET_DEFAULT_SIGNALS).toEqual(['traces', 'metrics']);
    const defaults = destinationFromAddArgs({ name: 'c', preset: 'otlp', endpoint: 'https://c.example.com' }, {});
    expect(defaults.signals).toEqual(['traces', 'metrics']);
    const withLogs = destinationFromAddArgs(
      { name: 'c', preset: 'otlp', endpoint: 'https://c.example.com', signals: ['traces,metrics,logs'] },
      {},
    );
    expect(withLogs.signals).toEqual(['traces', 'metrics', 'logs']);
  });

  it('strips local paths unless --include-local-paths is given', () => {
    const otlp = destinationFromAddArgs({ name: 'c', preset: 'otlp', endpoint: 'https://c.example.com' }, {});
    expect(otlp.includeLocalPaths).toBeUndefined();
    const lf = destinationFromAddArgs({ name: 'lf', preset: 'langfuse' }, { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' });
    expect(lf.includeLocalPaths).toBeUndefined();
    expect(
      destinationFromAddArgs({ name: 'c', preset: 'otlp', endpoint: 'https://c.example.com', includeLocalPaths: true }, {}).includeLocalPaths,
    ).toBe(true);
    expect(
      destinationFromAddArgs({ name: 'lf', preset: 'langfuse', includeLocalPaths: true }, { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' })
        .includeLocalPaths,
    ).toBe(true);
    // A file written before the field existed still parses and keeps the default.
    expect(telemetryDestinationSchema.parse({ name: 'old', endpoint: 'https://o.example.com', signals: ['traces'] }).includeLocalPaths).toBeUndefined();
  });

  it('denies every HAR resource attribute that holds a local path (the factory.local.* namespace)', () => {
    const attrs = buildOtelResourceAttributes({
      sessionKey: 'k',
      agentId: 1,
      repoPath: '/home/me/repo',
      workDir: '/home/me/worktrees/slot-1',
      branch: 'b',
      producerVersion: '2.0.0',
    });
    const pathKeys = attrs
      .split(',')
      .map((pair) => pair.split('='))
      .filter(([, value]) => value?.startsWith('/'))
      .map(([key]) => key);
    expect(pathKeys.sort()).toEqual(['factory.local.checkout_path', 'factory.local.work_dir']);
    for (const key of pathKeys) expect(attributeKeyDenied(key, TELEMETRY_LOCAL_PATH_ATTRIBUTES)).toBe(true);
    expect(TELEMETRY_LOCAL_PATH_ATTRIBUTES).toContain('factory.local.*');
  });

  it('matches denied keys exactly, and factory.local.* as a prefix rule', () => {
    expect(attributeKeyDenied('factory.local.anything_new', TELEMETRY_LOCAL_PATH_ATTRIBUTES)).toBe(true);
    expect(attributeKeyDenied('process.cwd', TELEMETRY_LOCAL_PATH_ATTRIBUTES)).toBe(true);
    expect(attributeKeyDenied('factory.localized', TELEMETRY_LOCAL_PATH_ATTRIBUTES)).toBe(false);
    expect(attributeKeyDenied('factory.work_unit.id', TELEMETRY_LOCAL_PATH_ATTRIBUTES)).toBe(false);
    expect(attributeKeyDenied('process.cwd.extra', TELEMETRY_LOCAL_PATH_ATTRIBUTES)).toBe(false);
  });

  it('strips account identity unless --include-account-identity is given', () => {
    const lfEnv = { LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' };
    const otlp = destinationFromAddArgs({ name: 'c', preset: 'otlp', endpoint: 'https://c.example.com' }, {});
    const lf = destinationFromAddArgs({ name: 'lf', preset: 'langfuse' }, lfEnv);
    expect(otlp.includeAccountIdentity).toBeUndefined();
    expect(lf.includeAccountIdentity).toBeUndefined();
    expect(
      destinationFromAddArgs({ name: 'c', preset: 'otlp', endpoint: 'https://c.example.com', includeAccountIdentity: true }, {})
        .includeAccountIdentity,
    ).toBe(true);
    expect(destinationFromAddArgs({ name: 'lf', preset: 'langfuse', includeAccountIdentity: true }, lfEnv).includeAccountIdentity).toBe(true);
    // Independent of the local paths opt-in.
    expect(destinationFromAddArgs({ name: 'c', preset: 'otlp', endpoint: 'https://c.example.com', includeLocalPaths: true }, {}).includeAccountIdentity)
      .toBeUndefined();
    expect(telemetryDestinationSchema.parse({ name: 'old', endpoint: 'https://o.example.com', signals: ['traces'] }).includeAccountIdentity).toBeUndefined();
  });

  it("denies Claude Code's account identity attributes by default", () => {
    for (const key of ['user.email', 'user.account_uuid', 'user.account_id', 'user.id', 'organization.id', 'enduser.id']) {
      expect(TELEMETRY_ACCOUNT_IDENTITY_ATTRIBUTES).toContain(key);
      expect(TELEMETRY_FORWARD_DENIED_ATTRIBUTES).toContain(key);
    }
    // Correlation keys stay: they are opaque ids, not the person.
    for (const key of ['session.id', 'factory.work_unit.id', 'factory.attempt.id']) {
      expect(TELEMETRY_FORWARD_DENIED_ATTRIBUTES).not.toContain(key);
    }
  });

  it('computes the per-destination denylist from the two opt-ins', () => {
    expect([...forwardDeniedAttributes({})].sort()).toEqual([...TELEMETRY_FORWARD_DENIED_ATTRIBUTES].sort());
    expect(forwardDeniedAttributes({ includeLocalPaths: true })).toEqual([...TELEMETRY_ACCOUNT_IDENTITY_ATTRIBUTES]);
    expect(forwardDeniedAttributes({ includeAccountIdentity: true })).toEqual([...TELEMETRY_LOCAL_PATH_ATTRIBUTES]);
    expect(forwardDeniedAttributes({ includeLocalPaths: true, includeAccountIdentity: true })).toEqual([]);
  });
});
