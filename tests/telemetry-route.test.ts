import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import yargs from 'yargs';
import { writeTelemetryLevel } from '../src/core/telemetry-config';
import {
  addTelemetryDestination,
  buildLangfuseDestination,
  buildOtlpDestination,
} from '../src/core/telemetry-destinations';
import {
  MISSION_CONTROL_DESTINATION,
  OTEL_HOOK_DESTINATIONS_MIN_VERSION,
  ROUTE_STRIP_LOCAL_ENV,
  buildRouteEnv,
  describeAgentTelemetryRoute,
  getRouteEnvPath,
  otelHookSupportsDestinations,
  readAppliedAgentRoute,
  resolveAgentTelemetryRoute,
  selectAgentTelemetryRoute,
  stripLocalResourceAttributes,
  writeRouteEnv,
  type FanoutAgentTelemetryRoute,
} from '../src/core/telemetry-route';
import {
  applyAgentTelemetryRoute,
  buildOtelHooksConfig,
  inspectTelemetryDrift,
  writeOtelHooksWrapper,
} from '../src/core/otel-hooks';
import { buildOtelResourceAttributes, buildTelemetryEnvBlock } from '../src/core/telemetry-env';
import { telemetryCommand } from '../src/cli/commands/telemetry';
import type { TelemetryDestination } from '../src/harness/schema';

const PUBLIC_KEY = 'pk-lf-public';
const SECRET_KEY = 'sk-lf-very-secret';
const TOKEN = Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64');
const MC = 'http://control.example:3847';

const langfuse = (name = 'langfuse', extra: { includeLocalPaths?: boolean } = {}) =>
  buildLangfuseDestination({ name, host: 'https://langfuse.example', publicKey: PUBLIC_KEY, secretKey: SECRET_KEY, ...extra });
const collector = (name: string, signals: Array<'traces' | 'logs' | 'metrics'> = ['traces', 'metrics']) =>
  buildOtlpDestination({ name, endpoint: 'http://collector.example:4318', headers: { 'x-api-key': 'abc def' }, signals });
const fanout = (missionControl: string | undefined, ...destinations: TelemetryDestination[]): FanoutAgentTelemetryRoute => ({
  mode: 'fanout',
  ...(missionControl ? { missionControl } : {}),
  destinations,
});

const ENV_KEYS = [
  'HAR_TELEMETRY',
  'HAR_TELEMETRY_CONFIG_PATH',
  'HAR_CONTROL_DISABLED',
  'HAR_CONTROL_API_URL',
  'HAR_OTEL_HOOKS_HOME',
  'HAR_DESTINATIONS_DIR',
] as const;

describe('agent telemetry route: fan-out at the producer', () => {
  const saved: Record<string, string | undefined> = {};
  let tmp: string;
  let hooksHome: string;

  /** A fake otel-hook install in the hooks home. */
  const installOtelHook = (version: string, cliBody = '// cli\n') => {
    const pkgDir = path.join(hooksHome, 'node_modules', '@osfactory', 'otel-hook');
    fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@osfactory/otel-hook', version, bin: { 'otel-hook': 'dist/cli.js' } }),
    );
    fs.writeFileSync(path.join(pkgDir, 'dist', 'cli.js'), cliBody);
  };
  /** Mission Control enabled at a custom URL, which counts as set up. */
  const missionControlOn = () => {
    process.env.HAR_CONTROL_DISABLED = 'false';
    process.env.HAR_CONTROL_API_URL = MC;
  };

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-route-'));
    hooksHome = path.join(tmp, 'otel-hooks');
    fs.mkdirSync(hooksHome, { recursive: true });
    delete process.env.HAR_TELEMETRY;
    process.env.HAR_TELEMETRY_CONFIG_PATH = path.join(tmp, 'telemetry.json');
    process.env.HAR_CONTROL_DISABLED = 'true';
    process.env.HAR_CONTROL_API_URL = 'http://127.0.0.1:9';
    process.env.HAR_OTEL_HOOKS_HOME = hooksHome;
    process.env.HAR_DESTINATIONS_DIR = path.join(tmp, 'destinations');
    writeTelemetryLevel('full');
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('route selection', () => {
    const base = { telemetryEnabled: true, controlAvailable: false, controlApiUrl: MC, otelHookSupportsDestinations: true };

    it('is off when telemetry is off', () => {
      expect(
        selectAgentTelemetryRoute({ ...base, controlAvailable: true, telemetryEnabled: false, destinations: [langfuse()] }).route,
      ).toEqual({ mode: 'off' });
    });

    it('Mission Control only', () => {
      expect(selectAgentTelemetryRoute({ ...base, controlAvailable: true, destinations: [] })).toEqual({
        route: { mode: 'fanout', missionControl: MC, destinations: [] },
      });
    });

    it('Mission Control plus every enabled destination with an OTLP signal, in file order (one route, no control/direct split)', () => {
      const decision = selectAgentTelemetryRoute({
        ...base,
        controlAvailable: true,
        destinations: [langfuse(), collector('m', ['metrics']), collector('otel'), collector('logs-only', ['logs']), { ...collector('off'), enabled: false }],
      });
      expect(decision.hint).toBeUndefined();
      expect(decision.route.mode === 'fanout' && decision.route.missionControl).toBe(MC);
      expect(decision.route.mode === 'fanout' && decision.route.destinations.map((d) => d.name)).toEqual([
        'langfuse',
        'm',
        'otel',
        'logs-only',
      ]);
      expect(describeAgentTelemetryRoute(decision.route)).toBe('→ mission-control, langfuse, m, otel, logs-only');
    });

    it('destinations only, when Mission Control is off or not set up', () => {
      const destinations = [langfuse(), collector('a', ['logs'])];
      const decision = selectAgentTelemetryRoute({ ...base, destinations });
      expect(decision.route).toEqual(fanout(undefined, ...destinations));
      expect(describeAgentTelemetryRoute(decision.route)).toBe('→ langfuse, a');
    });

    it('nowhere when there is neither', () => {
      const decision = selectAgentTelemetryRoute({ ...base, destinations: [{ ...collector('m', ['metrics']), enabled: false }] });
      expect(decision.route).toEqual(fanout(undefined));
      expect(describeAgentTelemetryRoute(decision.route)).toMatch(/^nowhere/);
    });

    it('keeps Mission Control but names the destinations and the version before otel-hook 0.9.0', () => {
      const decision = selectAgentTelemetryRoute({
        ...base,
        controlAvailable: true,
        otelHookSupportsDestinations: false,
        destinations: [langfuse(), collector('otel')],
      });
      expect(decision.route).toEqual(fanout(MC));
      expect(decision.hint).toContain('"langfuse" and "otel"');
      expect(decision.hint).toContain(`@osfactory/otel-hook ${OTEL_HOOK_DESTINATIONS_MIN_VERSION}`);
      expect(OTEL_HOOK_DESTINATIONS_MIN_VERSION).toBe('0.9.0');
    });

    it('resolves from the preference, HAR_CONTROL_DISABLED, HAR_CONTROL_API_URL and the destinations file', () => {
      installOtelHook(OTEL_HOOK_DESTINATIONS_MIN_VERSION);
      addTelemetryDestination(langfuse());
      const direct = resolveAgentTelemetryRoute(hooksHome).route;
      expect(direct.mode === 'fanout' && direct.missionControl).toBeUndefined();
      expect(direct.mode === 'fanout' && direct.destinations.map((d) => d.name)).toEqual(['langfuse']);
      writeTelemetryLevel('off');
      expect(resolveAgentTelemetryRoute(hooksHome).route.mode).toBe('off');
      writeTelemetryLevel('full');
      missionControlOn();
      const route = resolveAgentTelemetryRoute(hooksHome).route;
      expect(route.mode === 'fanout' && route.missionControl).toBe(MC);
      expect(route.mode === 'fanout' && route.destinations.map((d) => d.name)).toEqual(['langfuse']);
    });
  });

  describe('otel-hook version gate', () => {
    it('accepts the first release with exporter.destinations[] and env: header values', () => {
      installOtelHook(OTEL_HOOK_DESTINATIONS_MIN_VERSION);
      expect(otelHookSupportsDestinations(hooksHome)).toBe(true);
    });

    it('rejects an older release', () => {
      installOtelHook('0.8.0');
      expect(otelHookSupportsDestinations(hooksHome)).toBe(false);
    });

    it('accepts an unreleased build (HAR_OTEL_HOOKS_PACKAGE) with env: header values', () => {
      installOtelHook('0.8.0', 'const HEADER_ENV_REFERENCE_PREFIX = "env:";\n');
      expect(otelHookSupportsDestinations(hooksHome)).toBe(true);
    });

    it('rejects a missing install', () => {
      expect(otelHookSupportsDestinations(hooksHome)).toBe(false);
    });

    it('writes Mission Control as the single endpoint for an older otel-hook, and the list once it is upgraded', () => {
      missionControlOn();
      addTelemetryDestination(langfuse());
      installOtelHook('0.8.0');
      const before = applyAgentTelemetryRoute(hooksHome);
      expect(before.decision.hint).toContain(OTEL_HOOK_DESTINATIONS_MIN_VERSION);
      const old = JSON.parse(fs.readFileSync(before.configPath, 'utf8')) as { exporter: Record<string, unknown> };
      expect(old.exporter.endpoint).toBe(`${MC}/api/otel/v1/traces`);
      expect(old.exporter.destinations).toBeUndefined();
      installOtelHook(OTEL_HOOK_DESTINATIONS_MIN_VERSION);
      const after = applyAgentTelemetryRoute(hooksHome);
      const current = JSON.parse(fs.readFileSync(after.configPath, 'utf8')) as { exporter: { endpoint?: string; destinations: Array<{ name: string }> } };
      expect(current.exporter.endpoint).toBeUndefined();
      expect(current.exporter.destinations.map((d) => d.name)).toEqual(['mission-control', 'langfuse']);
    });
  });

  describe('hook config: one destination list', () => {
    const OTEL_SECRET = 'collector-secret-value';
    const team = () =>
      buildOtlpDestination({
        name: 'Team.Collector',
        endpoint: 'http://collector.example:4318/',
        headers: { 'x-api-key': OTEL_SECRET, 'x-tenant': 'acme' },
        signals: ['traces', 'logs', 'metrics'],
      });

    it('Mission Control only: traces, logs and metrics to its OTLP routes, no headers, no endpoint of its own', () => {
      const config = buildOtelHooksConfig({ route: fanout(MC) });
      expect(config.exporter.enabled).toBe(true);
      expect(config.exporter.endpoint).toBeUndefined();
      expect(config.exporter.logs.endpoint).toBeUndefined();
      expect(config.exporter.destinations).toEqual([
        {
          name: MISSION_CONTROL_DESTINATION,
          tracesEndpoint: `${MC}/api/otel/v1/traces`,
          logsEndpoint: `${MC}/api/otel/v1/logs`,
          metricsEndpoint: `${MC}/api/otel/v1/metrics`,
          signals: ['traces', 'logs', 'metrics'],
        },
      ]);
      expect(config.exporter.logs.enabled).toBe(true);
      expect(config.privacy.contentMode).toBe('raw');
    });

    it('sends Mission Control logs per telemetry level: none below Outline, spans and metrics from Usage', () => {
      writeTelemetryLevel('outline');
      const outline = buildOtelHooksConfig({ route: fanout(MC) });
      expect(outline.exporter.logs.includeContent).toBe(false);
      writeTelemetryLevel('usage');
      const usage = buildOtelHooksConfig({ route: fanout(MC) });
      expect(usage.exporter.enabled).toBe(true);
      expect(usage.exporter.logs.enabled).toBe(false);
      expect(usage.exporter.destinations?.map((d) => d.signals)).toEqual([['traces', 'metrics']]);
      writeTelemetryLevel('off');
      expect(buildOtelHooksConfig({ route: fanout(MC) }).exporter.destinations).toBeUndefined();
    });

    it('Mission Control plus N destinations: Mission Control first, env: references, per-signal endpoints', () => {
      const config = buildOtelHooksConfig({ route: fanout(MC, langfuse(), team()) });
      expect(config.exporter.endpoint).toBeUndefined();
      expect(config.exporter.destinations).toEqual([
        {
          name: 'mission-control',
          tracesEndpoint: `${MC}/api/otel/v1/traces`,
          logsEndpoint: `${MC}/api/otel/v1/logs`,
          metricsEndpoint: `${MC}/api/otel/v1/metrics`,
          signals: ['traces', 'logs', 'metrics'],
        },
        {
          name: 'langfuse',
          tracesEndpoint: 'https://langfuse.example/api/public/otel/v1/traces',
          headers: { Authorization: 'env:HAR_OTEL_DIRECT_HEADER_1_1' },
          signals: ['traces'],
        },
        {
          name: 'team-collector',
          tracesEndpoint: 'http://collector.example:4318/v1/traces',
          logsEndpoint: 'http://collector.example:4318/v1/logs',
          metricsEndpoint: 'http://collector.example:4318/v1/metrics',
          headers: { 'x-api-key': 'env:HAR_OTEL_DIRECT_HEADER_2_1', 'x-tenant': 'env:HAR_OTEL_DIRECT_HEADER_2_2' },
          signals: ['traces', 'logs', 'metrics'],
        },
      ]);
      expect(config.exporter.metrics).toEqual({ includeSessionId: true });
      const json = JSON.stringify(config);
      for (const secret of [SECRET_KEY, TOKEN, OTEL_SECRET, 'acme']) expect(json).not.toContain(secret);
    });

    it('destinations only: the list without Mission Control, logs only where subscribed', () => {
      const config = buildOtelHooksConfig({ route: fanout(undefined, langfuse()) });
      expect(config.exporter.destinations).toEqual([
        {
          name: 'langfuse',
          tracesEndpoint: 'https://langfuse.example/api/public/otel/v1/traces',
          headers: { Authorization: 'env:HAR_OTEL_DIRECT_HEADER_1_1' },
          signals: ['traces'],
        },
      ]);
      expect(config.exporter.logs.enabled).toBe(false);
      expect(config.privacy.contentMode).toBe('omit');
    });

    it('exports nothing with nowhere to send', () => {
      const config = buildOtelHooksConfig({ route: fanout(undefined) });
      expect(config.exporter.enabled).toBe(false);
      expect(config.exporter.destinations).toBeUndefined();
    });

    it('gives otel-hook valid, unique destination names, never "default", Mission Control keeping its own', () => {
      const names = buildOtelHooksConfig({
        route: fanout(MC, collector('Default'), collector('a.b'), collector('A_B'), collector('a-b'), collector('mission-control')),
      }).exporter.destinations?.map((d) => d.name);
      expect(names).toEqual(['mission-control', 'default-2', 'a-b', 'a_b', 'a-b-2', 'mission-control-2']);
      for (const name of names ?? []) expect(name).toMatch(/^[a-z0-9][a-z0-9_-]{0,62}$/);
    });

    it('keeps OTLP/HTTP protobuf, the only protocol otel-hook exports, for an http/json destination', () => {
      const json = { ...collector('otel'), protocol: 'http/json' as const };
      expect(buildOtelHooksConfig({ route: fanout(undefined, json) }).exporter.protocol).toBe('http/protobuf');
    });
  });

  describe('local paths: stripped for every destination unless it opts in (ADR 0004 section 6)', () => {
    const attrs = 'factory.local.work_dir=/home/dev/wt,session.id=s1';

    it('strips factory.local.* with Mission Control in the list too', () => {
      const route = fanout(MC, langfuse());
      expect(buildOtelHooksConfig({ route, resourceAttributes: attrs }).exporter.resourceAttributes).toEqual({ 'session.id': 's1' });
      expect(buildRouteEnv(route)).toContain(`export ${ROUTE_STRIP_LOCAL_ENV}=1`);
      writeRouteEnv(route, hooksHome);
      expect(readAppliedAgentRoute(hooksHome)?.includeLocalPaths).toBe(false);
    });

    it('keeps them only when every entry, Mission Control included, sets includeLocalPaths', () => {
      const both = fanout(undefined, langfuse('a', { includeLocalPaths: true }), langfuse('b', { includeLocalPaths: true }));
      const one = fanout(undefined, langfuse('a', { includeLocalPaths: true }), langfuse('b'));
      const withMc: FanoutAgentTelemetryRoute = { ...both, missionControl: MC, missionControlIncludesLocalPaths: true };
      for (const route of [both, withMc]) {
        expect(buildOtelHooksConfig({ route, resourceAttributes: attrs }).exporter.resourceAttributes).toHaveProperty([
          'factory.local.work_dir',
        ]);
        expect(buildRouteEnv(route)).not.toContain(ROUTE_STRIP_LOCAL_ENV);
      }
      expect(buildRouteEnv({ ...both, missionControl: MC })).toContain(ROUTE_STRIP_LOCAL_ENV);
      expect(buildOtelHooksConfig({ route: one, resourceAttributes: attrs }).exporter.resourceAttributes).toEqual({
        'session.id': 's1',
      });
      expect(buildRouteEnv(one)).toContain(`export ${ROUTE_STRIP_LOCAL_ENV}=1`);
      writeRouteEnv(one, hooksHome);
      expect(readAppliedAgentRoute(hooksHome)?.includeLocalPaths).toBe(false);
    });

    it('follows the same rule in .env.agent', () => {
      const session = { sessionKey: 'feat-x', agentId: 2, repoPath: '/home/dev/repo', workDir: '/home/dev/wt', repositoryUrl: 'https://github.com/o/r' };
      expect(buildOtelResourceAttributes(session, { omitLocalPaths: true })).not.toContain('factory.local.');
      writeRouteEnv(fanout(MC, langfuse()), hooksHome);
      expect(buildTelemetryEnvBlock(session)).not.toContain('factory.local.');
      writeRouteEnv(fanout(undefined, langfuse()), hooksHome);
      expect(buildTelemetryEnvBlock(session)).not.toContain('factory.local.');
      writeRouteEnv(fanout(undefined, langfuse('lf', { includeLocalPaths: true })), hooksHome);
      expect(buildTelemetryEnvBlock(session)).toContain('factory.local.');
    });

    it('strips factory.local.* from a resource attributes value', () => {
      expect(stripLocalResourceAttributes('a=1,factory.local.x=/p, factory.local.y=/q,b=2')).toBe('a=1,b=2');
    });
  });

  describe('direct.env', () => {
    it('holds only the raw header values, unsetting what would add a default destination', () => {
      const team = buildOtlpDestination({ name: 'team', endpoint: 'http://c.example:4318', headers: { 'x-k': 'v1' }, signals: ['traces', 'logs'] });
      const filePath = writeRouteEnv(fanout(MC, langfuse(), team), hooksHome) as string;
      expect(filePath).toBe(getRouteEnvPath(hooksHome));
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      const content = fs.readFileSync(filePath, 'utf8');
      expect(content).toContain(`export HAR_OTEL_DIRECT_HEADER_1_1='Basic ${TOKEN}'`);
      expect(content).toContain("export HAR_OTEL_DIRECT_HEADER_2_1='v1'");
      expect(content).not.toContain('langfuse.example');
      expect(content).not.toContain(MC);
      expect(content).toMatch(/^unset OTEL_HOOK_EXPORTER_ENDPOINT OTEL_HOOK_LOGS_ENDPOINT .*OTEL_EXPORTER_OTLP_LOGS_HEADERS$/m);
      expect(content).not.toMatch(/^export OTEL_EXPORTER_OTLP_/m);
      expect(content).toContain('export OTEL_HOOK_LOGS_ENABLED=true');
      expect(readAppliedAgentRoute(hooksHome)).toEqual({
        missionControl: true,
        destinations: ['langfuse', 'team'],
        logs: true,
        includeLocalPaths: false,
      });
    });

    it('is written for Mission Control alone too, with no header at all', () => {
      const content = buildRouteEnv(fanout(MC));
      expect(content).not.toMatch(/HAR_OTEL_DIRECT_HEADER_/);
      expect(content).toContain('export OTEL_HOOK_LOGS_ENABLED=true');
    });

    it('turns logs off when no entry takes them', () => {
      expect(buildRouteEnv(fanout(undefined, langfuse()))).toContain('export OTEL_HOOK_LOGS_ENABLED=false');
    });

    it('reads the route a 2.0.0-next.3 direct.env recorded', () => {
      fs.writeFileSync(getRouteEnvPath(hooksHome), '# har-direct: destination=langfuse,otel logs=false include-local-paths=false\n');
      expect(readAppliedAgentRoute(hooksHome)).toEqual({
        missionControl: false,
        destinations: ['langfuse', 'otel'],
        logs: false,
        includeLocalPaths: false,
      });
    });

    it('is removed when telemetry is off', () => {
      writeRouteEnv(fanout(MC), hooksHome);
      writeRouteEnv({ mode: 'off' }, hooksHome);
      expect(fs.existsSync(getRouteEnvPath(hooksHome))).toBe(false);
      expect(readAppliedAgentRoute(hooksHome)).toBeNull();
    });
  });

  describe('applying the route and the wrapper', () => {
    it('applies the route: config, direct.env, and no drift warning', () => {
      installOtelHook(OTEL_HOOK_DESTINATIONS_MIN_VERSION);
      missionControlOn();
      addTelemetryDestination(langfuse());
      const { decision, configPath } = applyAgentTelemetryRoute(hooksHome);
      expect(describeAgentTelemetryRoute(decision.route)).toBe('→ mission-control, langfuse');
      const written = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { exporter: Record<string, unknown> };
      expect(written.exporter.endpoint).toBeUndefined();
      expect(written.exporter.destinations).toHaveLength(2);
      expect(fs.statSync(getRouteEnvPath(hooksHome)).mode & 0o777).toBe(0o600);
      expect(inspectTelemetryDrift(hooksHome).mismatches).toEqual([]);

      writeTelemetryLevel('off');
      applyAgentTelemetryRoute(hooksHome);
      expect(fs.existsSync(getRouteEnvPath(hooksHome))).toBe(false);
    });

    it('reports no drift for a destinations-only route that leaves logs off', () => {
      installOtelHook(OTEL_HOOK_DESTINATIONS_MIN_VERSION);
      addTelemetryDestination(langfuse());
      applyAgentTelemetryRoute(hooksHome);
      expect(inspectTelemetryDrift(hooksHome).mismatches).toEqual([]);
    });

    it('runs otel-hook with the header values in its environment, never in the config, wrapper or argv', () => {
      const OTEL_SECRET = 'collector-secret-value';
      const dump = path.join(tmp, 'dump.json');
      const fakeHook = path.join(tmp, 'fake-otel-hook');
      fs.writeFileSync(
        fakeHook,
        `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n`,
        { mode: 0o755 },
      );
      installOtelHook(OTEL_HOOK_DESTINATIONS_MIN_VERSION);
      missionControlOn();
      addTelemetryDestination(langfuse());
      addTelemetryDestination(
        buildOtlpDestination({ name: 'team', endpoint: 'http://c.example:4318', headers: { 'x-api-key': OTEL_SECRET }, signals: ['traces'] }),
      );
      const { configPath } = applyAgentTelemetryRoute(hooksHome);
      const wrapper = writeOtelHooksWrapper(fakeHook, hooksHome);
      for (const file of [configPath, wrapper]) {
        const text = fs.readFileSync(file, 'utf8');
        for (const secret of [SECRET_KEY, TOKEN, OTEL_SECRET]) expect(text).not.toContain(secret);
      }
      expect(fs.readFileSync(wrapper, 'utf8')).toContain(getRouteEnvPath(hooksHome));
      const result = spawnSync('bash', [wrapper, '--provider', 'claude-code'], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          HAR_RESOURCE_ATTRIBUTES: 'session.id=s1,factory.local.work_dir=/home/dev/wt',
          OTEL_EXPORTER_OTLP_ENDPOINT: 'http://would-add-a-default.example',
          OTEL_HOOK_EXPORTER_ENDPOINT: 'http://would-win.example/v1/traces',
        },
      });
      expect(result.status).toBe(0);
      const seen = JSON.parse(fs.readFileSync(dump, 'utf8')) as { argv: string[]; env: Record<string, string> };
      for (const secret of [TOKEN, OTEL_SECRET]) expect(seen.argv.join(' ')).not.toContain(secret);
      expect(seen.env.HAR_OTEL_DIRECT_HEADER_1_1).toBe(`Basic ${TOKEN}`);
      expect(seen.env.HAR_OTEL_DIRECT_HEADER_2_1).toBe(OTEL_SECRET);
      expect(seen.env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
      expect(seen.env.OTEL_HOOK_EXPORTER_ENDPOINT).toBeUndefined();
      // No destination opted in to local paths, Mission Control included: the wrapper drops them.
      expect(seen.env.OTEL_RESOURCE_ATTRIBUTES).toBe('session.id=s1');

      // Without Mission Control too.
      writeRouteEnv(fanout(undefined, langfuse()), hooksHome);
      spawnSync('bash', [wrapper], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          OTEL_RESOURCE_ATTRIBUTES: 'session.id=s1,factory.slot.id=1, factory.local.checkout.path=/home/dev/repo',
        },
      });
      const after = JSON.parse(fs.readFileSync(dump, 'utf8')) as { env: Record<string, string> };
      expect(after.env.OTEL_RESOURCE_ATTRIBUTES).toBe('session.id=s1,factory.slot.id=1');
    });

    describe('when the agent strips OTEL_* from its hooks (Claude Code >= 2.1.128, #484)', () => {
      const sessionAttrs = {
        sessionKey: 'feat-x',
        agentId: 4,
        repoPath: '/home/dev/repo',
        workDir: '/home/dev/wt',
        workUnitId: 'W-484',
        repositoryUrl: 'https://github.com/o/r',
      };

      /**
       * Source a real `.env.agent` block, then run the generated wrapper the
       * way Claude Code runs a hook: every OTEL_* variable removed, everything
       * else inherited.
       */
      const runHookLikeClaudeCode = (block: string) => {
        const dump = path.join(tmp, 'dump.json');
        const fakeHook = path.join(tmp, 'fake-otel-hook');
        fs.writeFileSync(
          fakeHook,
          `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ env: process.env }));\n`,
          { mode: 0o755 },
        );
        const wrapper = writeOtelHooksWrapper(fakeHook, hooksHome);
        const envFile = path.join(tmp, '.env.agent.4');
        fs.writeFileSync(envFile, block);
        const script = [
          'set -a',
          `. ${JSON.stringify(envFile)}`,
          'set +a',
          'for _v in $(compgen -e | grep "^OTEL_"); do unset "$_v"; done',
          `[ -z "\${OTEL_RESOURCE_ATTRIBUTES:-}" ] || exit 7`,
          `exec bash ${JSON.stringify(wrapper)} --provider claude-code`,
        ].join('\n');
        const result = spawnSync('bash', ['-c', script], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH },
        });
        expect(result.status).toBe(0);
        const seen = JSON.parse(fs.readFileSync(dump, 'utf8')) as { env: Record<string, string> };
        return Object.fromEntries(
          (seen.env.OTEL_RESOURCE_ATTRIBUTES ?? '')
            .split(',')
            .filter(Boolean)
            .map((pair) => pair.split('=') as [string, string]),
        );
      };

      it('writes the profile twice in .env.agent: OTEL_RESOURCE_ATTRIBUTES and HAR_RESOURCE_ATTRIBUTES', () => {
        const block = buildTelemetryEnvBlock(sessionAttrs);
        const value = (name: string) =>
          block.split('\n').find((line) => line.startsWith(`${name}=`))?.slice(name.length + 1);
        expect(value('OTEL_RESOURCE_ATTRIBUTES')).toBeDefined();
        expect(value('HAR_RESOURCE_ATTRIBUTES')).toBe(value('OTEL_RESOURCE_ATTRIBUTES'));
      });

      it('restores session.id and the repository from HAR_RESOURCE_ATTRIBUTES, never work identity', () => {
        const attrs = runHookLikeClaudeCode(buildTelemetryEnvBlock(sessionAttrs));
        expect(attrs['session.id']).toBe('feat-x');
        expect(attrs['vcs.repository.url.full']).toBe('https://github.com/o/r');
        // Work identity is stamped from the session context only (ADR 0004 section 3).
        expect(Object.keys(attrs)).not.toContain('factory.slot.id');
        expect(Object.keys(attrs)).not.toContain('factory.work_unit.id');
        expect(Object.keys(attrs).filter((key) => key.startsWith('factory.local.'))).toEqual([]);
      });

      it('still strips factory.local.* from a block an older HAR wrote with local paths', () => {
        const block = 'OTEL_RESOURCE_ATTRIBUTES=session.id=feat-x,factory.local.work_dir=/home/dev/wt\nHAR_RESOURCE_ATTRIBUTES=session.id=feat-x,factory.local.work_dir=/home/dev/wt\n';
        writeRouteEnv(fanout(MC, langfuse()), hooksHome);
        const attrs = runHookLikeClaudeCode(block);
        expect(attrs['session.id']).toBe('feat-x');
        expect(Object.keys(attrs).filter((key) => key.startsWith('factory.local.'))).toEqual([]);
      });

      it('leaves the hook unchanged without HAR_RESOURCE_ATTRIBUTES (an agent outside a slot)', () => {
        const attrs = runHookLikeClaudeCode('PROBE_CONTROL=yes\n');
        expect(attrs).toEqual({});
      });
    });

  });

  describe('har telemetry status and destination list', () => {
    const capture = async (args: string[], until: (text: string) => boolean): Promise<string> => {
      const chunks: string[] = [];
      const out = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
      const log = jest.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => {
        chunks.push(parts.map(String).join(' '));
      });
      const err = jest.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
        chunks.push(parts.map(String).join(' '));
      });
      const warn = jest.spyOn(console, 'warn').mockImplementation((...parts: unknown[]) => {
        chunks.push(parts.map(String).join(' '));
      });
      try {
        await yargs(args).command(telemetryCommand).parseAsync();
        for (let waited = 0; waited < 5000 && !until(chunks.join('\n')); waited += 20) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        out.mockRestore();
        log.mockRestore();
        err.mockRestore();
        warn.mockRestore();
      }
      return chunks.join('\n');
    };
    const runStatus = (args: string[]) =>
      capture(['telemetry', 'status', ...args], (text) => text.includes('Hooks home') || text.includes('"levels"'));

    it('prints the real fan-out — Mission Control and each destination with its endpoint — without secrets', async () => {
      installOtelHook(OTEL_HOOK_DESTINATIONS_MIN_VERSION);
      missionControlOn();
      addTelemetryDestination(langfuse());
      applyAgentTelemetryRoute(hooksHome);

      const text = await runStatus([]);
      expect(text).toContain('Agent traces:  → mission-control, langfuse');
      expect(text).toMatch(/mission-control\s+traces http:\/\/control\.example:3847\/api\/otel\/v1\/traces, logs http:\/\/control\.example:3847\/api\/otel\/v1\/logs/);
      expect(text).toMatch(/langfuse\s+traces https:\/\/langfuse\.example\/api\/public\/otel\/v1\/traces/);
      expect(text).toContain('Local paths:   stripped from agent telemetry');
      expect(text).not.toContain('OTLP endpoint:');
      expect(text).not.toContain('run har telemetry on to apply');
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(SECRET_KEY);
    });

    it('keeps the JSON fields and adds the destination list', async () => {
      installOtelHook(OTEL_HOOK_DESTINATIONS_MIN_VERSION);
      missionControlOn();
      addTelemetryDestination(langfuse());
      addTelemetryDestination(collector('otel'));
      applyAgentTelemetryRoute(hooksHome);

      const json = await runStatus(['--json']);
      const parsed = JSON.parse(json) as Record<string, unknown> & { agentTraces: Record<string, unknown> };
      expect(parsed.otelEndpoint).toBe(`${MC}/api/otel`);
      expect(parsed.controlApiUrl).toBe(MC);
      expect(parsed.agentTraces).toMatchObject({
        mode: 'fanout',
        label: '→ mission-control, langfuse, otel',
        destinations: ['mission-control', 'langfuse', 'otel'],
        applied: ['mission-control', 'langfuse', 'otel'],
        targets: [
          { name: 'mission-control', tracesEndpoint: `${MC}/api/otel/v1/traces`, logsEndpoint: `${MC}/api/otel/v1/logs` },
          { name: 'langfuse', tracesEndpoint: 'https://langfuse.example/api/public/otel/v1/traces' },
          { name: 'otel', tracesEndpoint: 'http://collector.example:4318/v1/traces' },
        ],
      });
      expect(parsed.localPaths).toBe('stripped');
      expect(parsed).toHaveProperty('ingestQueues');
      expect(parsed).toHaveProperty('destinationHealth');
      expect(parsed).toHaveProperty('verificationTraces');
      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain('abc def');
    });

    it('says when agents still use an older route', async () => {
      installOtelHook(OTEL_HOOK_DESTINATIONS_MIN_VERSION);
      addTelemetryDestination(langfuse());
      applyAgentTelemetryRoute(hooksHome);
      missionControlOn();
      const text = await runStatus([]);
      expect(text).toContain('Agents currently send to langfuse — run har telemetry on to apply the route above.');
    });

    it('lists the route in har telemetry destination list, Mission Control included', async () => {
      installOtelHook(OTEL_HOOK_DESTINATIONS_MIN_VERSION);
      missionControlOn();
      addTelemetryDestination(langfuse());
      addTelemetryDestination(collector('otel'));
      addTelemetryDestination(collector('metrics-only', ['metrics']));
      applyAgentTelemetryRoute(hooksHome);
      const json = await capture(['telemetry', 'destination', 'list', '--json'], (text) => text.includes('agentTelemetry'));
      const parsed = JSON.parse(json) as { agentTelemetry: string[]; destinations: Array<{ name: string; preset: string }> };
      expect(parsed.agentTelemetry).toEqual(['mission-control', 'langfuse', 'otel', 'metrics-only']);
      expect(parsed.destinations.map((d) => [d.name, d.preset])).toEqual([
        ['mission-control', 'mission-control'],
        ['langfuse', 'langfuse'],
        ['otel', 'otlp'],
        ['metrics-only', 'otlp'],
      ]);
      expect(json).not.toContain(SECRET_KEY);

      const text = await capture(['telemetry', 'destination', 'list'], (out) => out.includes('Config:'));
      expect(text).toContain('Agent telemetry: → mission-control, langfuse, otel, metrics-only');
      expect(text).toContain('records, proofs, evidence: records, proofs, evidence');
      expect(text).toContain('local paths: stripped');
    });
  });
});
