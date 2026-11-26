import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeTelemetryLevel } from '../src/core/telemetry-config';
import {
  addDestination,
  buildGitNotesDestination,
  buildHqDestination,
  buildLangfuseDestination,
  buildMissionControlDestination,
  buildOtlpDestination,
  getDestinationsPath,
  getLegacyTelemetryDestinationsPath,
  materializeOtlpDestinations,
  readDestinations,
  removeDestination,
  writeDestinations,
} from '../src/core/telemetry-destinations';
import { drainIngestQueues, summarizeIngestQueues } from '../src/core/ingest-queue';
import { publishFactoryRun, publishIngest } from '../src/core/ingest-publish';
import { collectIngestHealth, withIngestHealth } from '../src/core/ingest-health';
import {
  CLAUDE_CODE_HOOK_FLAGS,
  applyAgentTelemetryRoute,
  buildOtelHooksConfig,
  buildProviderHookCommand,
  inspectHookCommandFlags,
} from '../src/core/otel-hooks';
import { getRouteEnvPath, resolveAgentTelemetryRoute } from '../src/core/telemetry-route';
import { INGEST_V2_FIXTURE_ENVELOPE, ingestV2FixtureRecords } from '../packages/schemas/src/ingest-v2-fixtures';
import {
  DESTINATIONS_FILE_VERSION,
  migrateTelemetryDestination,
  type HarDestination,
  type ValidationRecord,
} from '../src/harness/schema';
import type { DoctorReport } from '../src/harness/doctor';

const MC = 'http://mc.test:3847';
const HQ = 'http://hq.test/ingest';
const HQ_TOKEN = 'hq-ingest-key-very-secret';
const COLLECTOR_SECRET = 'collector-secret-value';

const ENV_KEYS = [
  'HAR_TELEMETRY',
  'HAR_TELEMETRY_CONFIG_PATH',
  'HAR_CONTROL_DISABLED',
  'HAR_CONTROL_API_URL',
  'HAR_OTEL_HOOKS_HOME',
  'HAR_DESTINATIONS_DIR',
  'HAR_INGEST_QUEUE_DIR',
  'HAR_PORTAL_URL',
  'HAR_PORTAL_TOKEN',
  'HAR_SESSIONS_DIR',
] as const;

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Buffer;
}

/**
 * Two ingest v2 receivers behind one fetch: Mission Control at `mc.test`, a
 * hosted receiver at `hq.test`. Each can be taken down; uploads are stored.
 */
function fakeReceivers() {
  const calls: Call[] = [];
  const down = new Set<string>();
  const stored = new Map<string, Map<string, Buffer>>();
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const host = new URL(url).host;
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    const body = init?.body as string | Buffer | undefined;
    calls.push({ method: init?.method ?? 'GET', url, headers, ...(body !== undefined ? { body } : {}) });
    if (down.has(host)) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const blobs = stored.get(host) ?? new Map<string, Buffer>();
    stored.set(host, blobs);
    if (url.endsWith('/v2/capabilities')) {
      return new Response(
        JSON.stringify({ contractVersion: '2', signals: ['traces'], recordTypes: ['WorkUnit'], proofs: true, evidence: true }),
        { status: 200 },
      );
    }
    if (url.endsWith('/v2/evidence/missing')) {
      const { digests } = JSON.parse(String(body)) as { digests: string[] };
      return new Response(
        JSON.stringify({ missing: digests.filter((d) => !blobs.has(d)).map((sha256) => ({ sha256, uploadUrl: `v2/evidence/${sha256}` })) }),
        { status: 200 },
      );
    }
    const put = /\/v2\/evidence\/([0-9a-f]{64})$/.exec(url);
    if (put && init?.method === 'PUT') {
      const bytes = Buffer.from(body as Buffer);
      if (createHash('sha256').update(bytes).digest('hex') !== put[1]) return new Response('', { status: 422 });
      blobs.set(put[1], bytes);
      return new Response('', { status: 201 });
    }
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const sent = (host: string, suffix: string) => calls.filter((call) => new URL(call.url).host === host && call.url.endsWith(suffix));
  return { calls, down, stored, fetchImpl, sent };
}

describe('one destination list, direct fan-out (ADR 0005 sections 2, 4, 6)', () => {
  const saved: Record<string, string | undefined> = {};
  let tmp: string;

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-ingest-'));
    delete process.env.HAR_TELEMETRY;
    process.env.HAR_TELEMETRY_CONFIG_PATH = path.join(tmp, 'telemetry.json');
    process.env.HAR_CONTROL_DISABLED = 'false';
    // A custom Mission Control URL counts as set up.
    process.env.HAR_CONTROL_API_URL = MC;
    process.env.HAR_OTEL_HOOKS_HOME = path.join(tmp, 'otel-hooks');
    process.env.HAR_DESTINATIONS_DIR = path.join(tmp, 'destinations');
    process.env.HAR_INGEST_QUEUE_DIR = path.join(tmp, 'queue');
    process.env.HAR_SESSIONS_DIR = path.join(tmp, 'sessions');
    // The HAR HQ override: url + key, no saved connection or attachment needed.
    process.env.HAR_PORTAL_URL = 'http://hq.test';
    process.env.HAR_PORTAL_TOKEN = HQ_TOKEN;
    writeTelemetryLevel('full');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  // The hosted receiver is scoped: it receives the one repository chosen for it.
  const REPO_URL = 'https://example.test/acme/app.git';
  const hqFor = (repoPath: string): HarDestination => ({
    ...buildHqDestination({ baseUrl: HQ }),
    repositories: [{ path: repoPath, url: REPO_URL, scope: 'full', content: 'raw' }],
  });
  const receiversList = (): HarDestination[] => [buildMissionControlDestination(), hqFor(tmp)];

  describe('the list', () => {
    it('is Mission Control alone by default, without writing anything', () => {
      const file = readDestinations();
      expect(file.destinations.map((d) => [d.name, d.preset, d.signals, d.records, d.proofs, d.evidence])).toEqual([
        ['mission-control', 'mission-control', ['traces', 'logs', 'metrics'], true, true, true],
      ]);
      expect(fs.existsSync(getDestinationsPath())).toBe(false);
    });

    it('migrates #522 telemetry.json: OTLP entries keep their signals and take no records; Mission Control is added', () => {
      const legacyPath = getLegacyTelemetryDestinationsPath();
      fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
      const langfuse = buildLangfuseDestination({ name: 'lf', host: 'https://lf.example', publicKey: 'pk', secretKey: 'sk' });
      fs.writeFileSync(legacyPath, JSON.stringify({ version: 1, destinations: [langfuse] }));
      const file = readDestinations();
      expect(file.version).toBe(DESTINATIONS_FILE_VERSION);
      expect(file.destinations.map((d) => d.name)).toEqual(['mission-control', 'lf']);
      expect(file.destinations[1]).toMatchObject({ preset: 'langfuse', signals: ['traces'], records: false, proofs: false, evidence: false });
      expect(fs.existsSync(getDestinationsPath())).toBe(true);
      expect(fs.existsSync(`${legacyPath}.migrated`)).toBe(true);
      expect(fs.statSync(getDestinationsPath()).mode & 0o777).toBe(0o600);
    });

    it('keeps a removed Mission Control disabled, so the default does not bring it back', () => {
      addDestination(buildGitNotesDestination());
      expect(removeDestination('mission-control')).toBe(true);
      const file = readDestinations();
      expect(file.destinations.find((d) => d.name === 'mission-control')?.enabled).toBe(false);
    });

    it('validates each preset: no records for otlp, no signals for git-notes, a base URL for hq', () => {
      const otlp = migrateTelemetryDestination(
        buildOtlpDestination({ name: 'c', endpoint: 'http://c.example:4318', signals: ['traces'] }),
      );
      expect(() => writeDestinations({ version: 2, destinations: [{ ...otlp, records: true }] })).toThrow(/does not take records/);
      expect(() =>
        writeDestinations({ version: 2, destinations: [{ ...buildGitNotesDestination(), signals: ['traces'] }] }),
      ).toThrow(/takes no OTLP signals/);
      expect(() => buildHqDestination({ baseUrl: '' })).toThrow();
    });

    it('never writes the HAR HQ key into the list, and resolves it for the OTLP side at send time', () => {
      writeDestinations({ version: 2, destinations: receiversList() });
      expect(fs.readFileSync(getDestinationsPath(), 'utf8')).not.toContain(HQ_TOKEN);
      const otlp = materializeOtlpDestinations(readDestinations());
      expect(otlp.map((d) => [d.name, d.endpoint, d.headers.Authorization])).toEqual([
        ['hq', `${HQ}/otel`, `Bearer ${HQ_TOKEN}`],
      ]);
      delete process.env.HAR_PORTAL_TOKEN;
      expect(materializeOtlpDestinations(readDestinations())).toEqual([]);
    });
  });

  describe('otel-hook config per ADR 0005 section 6', () => {
    it('one exporter.destinations[] entry per destination with its signals; transcript usage; session context; env: keys only', () => {
      const collector = migrateTelemetryDestination(
        buildOtlpDestination({
          name: 'team',
          endpoint: 'http://collector.example:4318',
          headers: { 'x-api-key': COLLECTOR_SECRET },
          signals: ['traces', 'metrics'],
        }),
      );
      writeDestinations({
        version: 2,
        destinations: [...receiversList(), buildGitNotesDestination(), { ...collector, includeSessionId: false }],
      });
      // otel-hook 0.14.0 (repository scopes) installed in the hooks home.
      const hooksHome = process.env.HAR_OTEL_HOOKS_HOME as string;
      const pkgDir = path.join(hooksHome, 'node_modules', '@osfactory', 'otel-hook');
      fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version: '0.14.0', bin: { 'otel-hook': 'dist/cli.js' } }));
      fs.writeFileSync(path.join(pkgDir, 'dist', 'cli.js'), '// cli\n');

      const { configPath } = applyAgentTelemetryRoute(hooksHome);
      const written = fs.readFileSync(configPath, 'utf8');
      expect(JSON.parse(written)).toEqual({
        exporter: {
          enabled: true,
          protocol: 'http/protobuf',
          serviceName: 'har-ide-agent',
          destinations: [
            {
              name: 'mission-control',
              tracesEndpoint: `${MC}/api/otel/v1/traces`,
              logsEndpoint: `${MC}/api/otel/v1/logs`,
              metricsEndpoint: `${MC}/api/otel/v1/metrics`,
              signals: ['traces', 'logs', 'metrics'],
            },
            {
              name: 'hq',
              tracesEndpoint: `${HQ}/otel/v1/traces`,
              logsEndpoint: `${HQ}/otel/v1/logs`,
              metricsEndpoint: `${HQ}/otel/v1/metrics`,
              headers: { Authorization: 'env:HAR_OTEL_DIRECT_HEADER_1_1' },
              signals: ['traces', 'logs', 'metrics'],
              scopes: [{ repositories: ['example.test/acme/app'], signals: ['traces', 'logs', 'metrics'], contentMode: 'raw' }],
            },
            {
              name: 'team',
              tracesEndpoint: 'http://collector.example:4318/v1/traces',
              metricsEndpoint: 'http://collector.example:4318/v1/metrics',
              headers: { 'x-api-key': 'env:HAR_OTEL_DIRECT_HEADER_2_1' },
              signals: ['traces', 'metrics'],
            },
          ],
          logs: { enabled: true, includeContent: true },
          // otel-hook has one setting for every destination: "team" turned it off.
          metrics: { includeSessionId: false },
        },
        privacy: { contentMode: 'raw', allowRawContent: true },
        providers: { claudeCode: { readTranscriptUsage: true } },
        sessionContext: { dir: path.resolve(process.env.HAR_SESSIONS_DIR as string) },
      });
      // No secret in the written config; the key lives only in direct.env (0600).
      for (const secret of [HQ_TOKEN, COLLECTOR_SECRET]) expect(written).not.toContain(secret);
      const routeEnv = fs.readFileSync(getRouteEnvPath(hooksHome), 'utf8');
      expect(routeEnv).toContain(`export HAR_OTEL_DIRECT_HEADER_1_1='Bearer ${HQ_TOKEN}'`);
      expect(fs.statSync(getRouteEnvPath(hooksHome)).mode & 0o777).toBe(0o600);
      // No identity through OTEL_* and no local paths: stripped for every destination by default.
      expect(written).not.toMatch(/(^|[^A-Z_])OTEL_/);
      expect(routeEnv).toContain('export HAR_OTEL_DIRECT_STRIP_LOCAL=1');
    });

    it('sends otel-hook usage to every receiver at the Usage level: spans and metrics, no event records', () => {
      writeTelemetryLevel('usage');
      writeDestinations({ version: 2, destinations: receiversList() });
      const hooksHome = path.join(tmp, 'hooks-0.14');
      const pkgDir = path.join(hooksHome, 'node_modules', '@osfactory', 'otel-hook');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version: '0.14.0' }));
      const config = buildOtelHooksConfig({ route: resolveAgentTelemetryRoute(hooksHome).route });
      expect(config.exporter.enabled).toBe(true);
      expect(config.exporter.logs.enabled).toBe(false);
      expect(config.exporter.destinations?.map((d) => [d.name, d.signals])).toEqual([
        ['mission-control', ['traces', 'metrics']],
        ['hq', ['traces', 'metrics']],
      ]);
      expect(config.providers).toEqual({ claudeCode: { readTranscriptUsage: true } });
    });

    it('gives an implicit Mission Control entry metrics too: it books Claude Code usage from otel-hook', () => {
      // No destinations file: Mission Control is in the list by default.
      const route = resolveAgentTelemetryRoute(path.join(tmp, 'none')).route;
      const config = buildOtelHooksConfig({ route });
      expect(config.exporter.destinations?.[0]).toMatchObject({
        name: 'mission-control',
        metricsEndpoint: `${MC}/api/otel/v1/metrics`,
        signals: ['traces', 'logs', 'metrics'],
      });
    });

    it('registers the Claude Code hook with transcript usage, logs and metrics, and Codex with rollout usage', () => {
      expect(buildProviderHookCommand('claude-code', '/h/run-otel-hook.sh')).toBe(
        '/h/run-otel-hook.sh --provider claude-code --claude-transcript-usage --logs --metrics',
      );
      expect(CLAUDE_CODE_HOOK_FLAGS).toEqual(['--claude-transcript-usage', '--logs', '--metrics']);
      expect(buildProviderHookCommand('codex', '/h/run-otel-hook.sh')).toBe(
        '/h/run-otel-hook.sh --provider codex --codex-rollout-usage',
      );
      expect(buildProviderHookCommand('cursor', '/h/run-otel-hook.sh')).toBe('/h/run-otel-hook.sh --provider cursor');
    });

    it('flags hook commands registered without the current flags (e.g. by HAR 1.x)', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'har-hook-flags-'));
      try {
        const write = (file: string, command: string) => {
          fs.mkdirSync(path.dirname(path.join(home, file)), { recursive: true });
          fs.writeFileSync(
            path.join(home, file),
            JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } }),
          );
        };
        write('.claude/settings.json', '/h/run-otel-hook.sh --provider claude-code --claude-transcript-usage --logs --metrics');
        write('.codex/hooks.json', '/h/run-otel-hook.sh --provider codex');
        expect(inspectHookCommandFlags(home)).toEqual([
          'codex hook command lacks --codex-rollout-usage (har telemetry install-hooks)',
        ]);
        write('.codex/hooks.json', buildProviderHookCommand('codex', '/h/run-otel-hook.sh'));
        expect(inspectHookCommandFlags(home)).toEqual([]);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it('writes no key an older otel-hook would reject', () => {
      const route = resolveAgentTelemetryRoute(path.join(tmp, 'none')).route;
      const config = buildOtelHooksConfig({
        route,
        features: { destinations: true, transcriptUsage: false, metrics: false, sessionContext: false, scopes: false },
      });
      expect(config).not.toHaveProperty('sessionContext');
      expect(config).not.toHaveProperty('providers');
      expect(config.exporter).not.toHaveProperty('metrics');
    });
  });

  describe('fan-out with one destination down', () => {
    it('others receive, the queue holds the failed one, a later drain sends it exactly once', async () => {
      const receivers = fakeReceivers();
      receivers.down.add('hq.test');
      const records = ingestV2FixtureRecords();
      const destinations = receiversList();
      writeDestinations({ version: 2, destinations });
      const first = await publishIngest(
        { records, proofs: [INGEST_V2_FIXTURE_ENVELOPE] },
        { destinations, fetchImpl: receivers.fetchImpl, repoPath: tmp },
      );
      expect(first.queued.sort()).toEqual(['hq', 'mission-control']);
      expect(receivers.sent('mc.test:3847', '/api/v2/records')).toHaveLength(1);
      expect(receivers.sent('mc.test:3847', '/api/v2/proofs')).toHaveLength(1);
      expect(JSON.parse(String(receivers.sent('mc.test:3847', '/api/v2/records')[0].body))).toEqual({ records });

      // The hosted receiver got one attempt, stopped at its first failure (FIFO), and keeps both sends.
      expect(receivers.sent('hq.test', '/ingest/v2/records')).toHaveLength(1);
      expect(receivers.sent('hq.test', '/ingest/v2/proofs')).toHaveLength(0);
      const queued = summarizeIngestQueues();
      expect(queued.find((q) => q.destination === 'hq')).toMatchObject({ depth: 2, lastError: 'ECONNREFUSED' });
      expect(queued.find((q) => q.destination === 'mission-control')).toMatchObject({ depth: 0 });
      // The key goes in the request header, never in the queue.
      expect(receivers.sent('hq.test', '/ingest/v2/records')[0].headers.Authorization).toBe(`Bearer ${HQ_TOKEN}`);
      const queueText = fs
        .readdirSync(path.join(tmp, 'queue', 'hq'))
        .filter((name) => name.endsWith('.json'))
        .map((name) => fs.readFileSync(path.join(tmp, 'queue', 'hq', name), 'utf8'))
        .join('\n');
      expect(queueText).not.toContain(HQ_TOKEN);

      // Back up: the drain (after the backoff) sends each queued send once, in order.
      receivers.down.delete('hq.test');
      const later = () => Date.now() + 60 * 60_000;
      const drained = await drainIngestQueues({ fetchImpl: receivers.fetchImpl, now: later });
      expect(drained).toMatchObject({ sent: 2, retried: 0, dead: 0, pending: 0 });
      const hqCalls = receivers.calls.filter((call) => call.url.startsWith(HQ)).map((call) => call.url.slice(HQ.length));
      expect(hqCalls).toEqual(['/v2/records', '/v2/records', '/v2/proofs']);

      // Nothing left: another drain sends nothing.
      const again = await drainIngestQueues({ fetchImpl: receivers.fetchImpl, now: later });
      expect(again).toMatchObject({ sent: 0, pending: 0 });
      expect(receivers.calls.filter((call) => call.url.startsWith(HQ))).toHaveLength(3);
      expect(summarizeIngestQueues().every((q) => q.depth === 0)).toBe(true);
    });

    it('queues the same send once, and drops what a removed destination still had', async () => {
      const receivers = fakeReceivers();
      receivers.down.add('hq.test');
      const destinations = receiversList();
      writeDestinations({ version: 2, destinations });
      const batch = { records: ingestV2FixtureRecords().slice(0, 2) };
      await publishIngest(batch, { destinations, fetchImpl: receivers.fetchImpl, repoPath: tmp });
      await publishIngest(batch, { destinations, fetchImpl: receivers.fetchImpl, repoPath: tmp, drain: false });
      expect(summarizeIngestQueues().find((q) => q.destination === 'hq')?.depth).toBe(1);

      writeDestinations({ version: 2, destinations: [buildMissionControlDestination()] });
      const drained = await drainIngestQueues({ fetchImpl: receivers.fetchImpl, now: () => Date.now() + 3_600_000 });
      expect(drained.dead).toBe(1);
      expect(summarizeIngestQueues().find((q) => q.destination === 'hq')).toMatchObject({ depth: 0, dead: 1 });
    });

    it('drops invalid records before queueing (validated against the ingest v2 schemas)', async () => {
      const receivers = fakeReceivers();
      const result = await publishIngest(
        { records: [{ type: 'Attempt', attemptId: 'a b' }, ingestV2FixtureRecords()[0]] },
        { destinations: [buildMissionControlDestination()], fetchImpl: receivers.fetchImpl, repoPath: tmp },
      );
      expect(result.queued).toEqual(['mission-control']);
      const body = JSON.parse(String(receivers.sent('mc.test:3847', '/api/v2/records')[0].body)) as { records: unknown[] };
      expect(body.records).toHaveLength(1);
    });
  });

  describe('evidence', () => {
    it('is copied into the queue at verify time and survives the slot work dir being deleted', async () => {
      const receivers = fakeReceivers();
      receivers.down.add('mc.test:3847');
      const harnessRoot = path.join(tmp, 'repo');
      const workDir = path.join(tmp, 'slot-work-dir');
      fs.mkdirSync(path.join(harnessRoot, '.har'), { recursive: true });
      const validationId = randomUUID();
      const logBytes = Buffer.from('[har] stage log\nall green\n');
      const logName = `${validationId}/unit-tests.log`;
      fs.mkdirSync(path.join(workDir, '.har', 'artifacts', validationId), { recursive: true });
      fs.writeFileSync(path.join(workDir, '.har', 'artifacts', logName), logBytes);
      const sha256 = createHash('sha256').update(logBytes).digest('hex');
      const now = new Date().toISOString();
      const validation: ValidationRecord = {
        validationId,
        treeHash: 'a'.repeat(40),
        workDir,
        harnessRoot,
        status: 'pass',
        full: true,
        changedFiles: [],
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        finishedAt: now,
        stageResults: [
          {
            stageId: 'unit-tests',
            status: 'passed',
            addedBy: 'policy',
            durationMs: 12,
            logDigest: sha256,
            artifacts: [{ name: logName, sha256, size: logBytes.length, mediaType: 'text/plain; charset=utf-8' }],
          },
        ],
      };

      await publishFactoryRun(
        { harnessRoot, checkoutDir: harnessRoot, validation, workDir },
        { destinations: [buildMissionControlDestination()], fetchImpl: receivers.fetchImpl },
      );
      expect(summarizeIngestQueues()[0]).toMatchObject({ destination: 'mission-control', queued: { records: 1, proofs: 0, evidence: 1 } });

      // Teardown deletes the work dir; the queue still has the bytes.
      fs.rmSync(workDir, { recursive: true, force: true });
      receivers.down.delete('mc.test:3847');
      const drained = await drainIngestQueues({ fetchImpl: receivers.fetchImpl, now: () => Date.now() + 3_600_000 });
      expect(drained).toMatchObject({ sent: 2, pending: 0 });

      const records = JSON.parse(String(receivers.sent('mc.test:3847', '/api/v2/records').at(-1)?.body)) as {
        records: Array<{ type: string }>;
      };
      expect(records.records.map((r) => r.type)).toEqual(['FactoryRun', 'StageResult']);
      expect(receivers.stored.get('mc.test:3847')?.get(sha256)?.equals(logBytes)).toBe(true);
      // Uploaded: the blob leaves the queue too.
      expect(fs.readdirSync(path.join(tmp, 'queue', 'mission-control', 'blobs'))).toEqual([]);
    });
  });

  describe('har telemetry status / har env doctor lines', () => {
    it('show queue depth, last success and last error per destination, and a receiver without v2 clearly', async () => {
      const receivers = fakeReceivers();
      receivers.down.add('hq.test');
      const destinations = receiversList();
      writeDestinations({ version: 2, destinations });
      await publishIngest(
        { records: ingestV2FixtureRecords().slice(0, 1) },
        { destinations, fetchImpl: receivers.fetchImpl, repoPath: tmp },
      );

      const status = await collectIngestHealth({ controlAvailable: true });
      const byName = Object.fromEntries(status.destinations.map((d) => [d.name, d]));
      expect(byName['mission-control'].summary).toMatch(/^mission-control: nothing queued, last success just now$/);
      expect(byName['mission-control'].status).toBe('pass');
      expect(byName.hq.summary).toMatch(/^hq: 1 queued \(records 1\), no success yet, last error just now \(ECONNREFUSED\)$/);
      expect(byName.hq.status).toBe('warn');

      // Doctor: GET v2/capabilities. A receiver without v2 answers 404.
      receivers.down.delete('hq.test');
      const v1Only = (async (input: string | URL, init?: RequestInit) =>
        String(input).startsWith(HQ) ? new Response('not found', { status: 404 }) : receivers.fetchImpl(input, init)) as typeof fetch;
      const doctor = await collectIngestHealth({ controlAvailable: true, checkCapabilities: true, fetchImpl: v1Only });
      const hq = doctor.destinations.find((d) => d.name === 'hq');
      expect(hq?.summary).toContain('does not support ingest v2 (GET v2/capabilities: HTTP 404) — upgrade the receiver');
      expect(doctor.destinations.find((d) => d.name === 'mission-control')?.summary).toContain('ingest v2 (records: 1, proofs: yes, evidence: yes');

      const base: DoctorReport = { ok: true, checks: [], findings: [] } as unknown as DoctorReport;
      const report = withIngestHealth(base, doctor);
      expect(report.ok).toBe(true);
      expect(report.checks).toEqual([expect.objectContaining({ id: 'ingest-destinations', status: 'warn' })]);
      expect(report.findings).toEqual([
        expect.objectContaining({ check: 'ingest-destinations', severity: 'warning', remedy: expect.stringContaining('does not support ingest v2') }),
      ]);
      expect(JSON.stringify(report)).not.toContain(HQ_TOKEN);
    });
  });
});
