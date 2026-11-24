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
  DIRECT_STRIP_LOCAL_ENV,
  OTEL_HOOK_DIRECT_MIN_VERSION,
  buildDirectExportEnv,
  encodeOtlpHeaders,
  getDirectExportEnvPath,
  otelHookSupportsDirectExport,
  readAppliedDirectRoute,
  resolveAgentTelemetryRoute,
  selectAgentTelemetryRoute,
  stripLocalResourceAttributes,
  writeDirectExportEnv,
} from '../src/core/telemetry-direct';
import {
  applyAgentTelemetryRoute,
  buildOtelHooksConfig,
  inspectTelemetryDrift,
  writeOtelHooksWrapper,
} from '../src/core/otel-hooks';
import { buildOtelResourceAttributes, buildTelemetryEnvBlock } from '../src/core/telemetry-env';
import { telemetryCommand } from '../src/cli/commands/telemetry';

const PUBLIC_KEY = 'pk-lf-public';
const SECRET_KEY = 'sk-lf-very-secret';
const TOKEN = Buffer.from(`${PUBLIC_KEY}:${SECRET_KEY}`).toString('base64');

const langfuse = (name = 'langfuse', extra: { includeLocalPaths?: boolean } = {}) =>
  buildLangfuseDestination({ name, host: 'https://langfuse.example', publicKey: PUBLIC_KEY, secretKey: SECRET_KEY, ...extra });
const collector = (name: string, signals: Array<'traces' | 'logs' | 'metrics'> = ['traces', 'metrics']) =>
  buildOtlpDestination({ name, endpoint: 'http://collector.example:4318', headers: { 'x-api-key': 'abc def' }, signals });

const ENV_KEYS = [
  'HAR_TELEMETRY',
  'HAR_TELEMETRY_CONFIG_PATH',
  'HAR_CONTROL_DISABLED',
  'HAR_CONTROL_API_URL',
  'HAR_OTEL_HOOKS_HOME',
  'HAR_DESTINATIONS_DIR',
] as const;

describe('direct export without Mission Control', () => {
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

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-direct-'));
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

  describe('mode selection', () => {
    const base = { telemetryEnabled: true, controlAvailable: false, otelHookSupportsDirect: true };

    it('is off when telemetry is off', () => {
      expect(selectAgentTelemetryRoute({ ...base, telemetryEnabled: false, destinations: [langfuse()] }).route).toEqual({
        mode: 'off',
      });
    });

    it('keeps Mission Control when it is on, whatever the destinations', () => {
      const decision = selectAgentTelemetryRoute({ ...base, controlAvailable: true, destinations: [langfuse()] });
      expect(decision).toEqual({ route: { mode: 'control' } });
    });

    it('stays on Mission Control with no destination', () => {
      expect(selectAgentTelemetryRoute({ ...base, destinations: [] })).toEqual({ route: { mode: 'control' } });
    });

    it('goes direct to the single traces destination', () => {
      const decision = selectAgentTelemetryRoute({ ...base, destinations: [langfuse(), collector('m', ['metrics'])] });
      expect(decision.route.mode).toBe('direct');
      expect(decision.route.mode === 'direct' && decision.route.destination.name).toBe('langfuse');
      expect(decision.hint).toBeUndefined();
    });

    it('ignores a disabled destination', () => {
      const disabled = { ...collector('off'), enabled: false };
      const decision = selectAgentTelemetryRoute({ ...base, destinations: [langfuse(), disabled] });
      expect(decision.route.mode).toBe('direct');
    });

    it('uses none of two traces destinations and says Mission Control fans out', () => {
      const decision = selectAgentTelemetryRoute({ ...base, destinations: [langfuse(), collector('otel')] });
      expect(decision.route).toEqual({ mode: 'control' });
      expect(decision.hint).toMatch(/single destination/);
      expect(decision.hint).toMatch(/har control up/);
    });

    it('names the otel-hook version an older install lacks', () => {
      const decision = selectAgentTelemetryRoute({ ...base, otelHookSupportsDirect: false, destinations: [langfuse()] });
      expect(decision.route).toEqual({ mode: 'control' });
      expect(decision.hint).toContain(`@osfactory/otel-hook ${OTEL_HOOK_DIRECT_MIN_VERSION}`);
    });

    it('resolves from the preference, HAR_CONTROL_DISABLED and the destinations file', () => {
      installOtelHook(OTEL_HOOK_DIRECT_MIN_VERSION);
      addTelemetryDestination(langfuse());
      expect(resolveAgentTelemetryRoute(hooksHome).route.mode).toBe('direct');
      writeTelemetryLevel('off');
      expect(resolveAgentTelemetryRoute(hooksHome).route.mode).toBe('off');
      writeTelemetryLevel('full');
      process.env.HAR_CONTROL_DISABLED = 'false';
      process.env.HAR_CONTROL_API_URL = 'http://control.example:3847';
      expect(resolveAgentTelemetryRoute(hooksHome).route.mode).toBe('control');
    });
  });

  describe('otel-hook version gate', () => {
    it('accepts the first release with the standard OTLP variables', () => {
      installOtelHook(OTEL_HOOK_DIRECT_MIN_VERSION);
      expect(otelHookSupportsDirectExport(hooksHome)).toBe(true);
    });

    it('rejects an older release', () => {
      installOtelHook('0.6.0');
      expect(otelHookSupportsDirectExport(hooksHome)).toBe(false);
    });

    it('accepts an unreleased build (HAR_OTEL_HOOKS_PACKAGE) that reads the header variables', () => {
      installOtelHook('0.6.0', 'const v = "OTEL_EXPORTER_OTLP_TRACES_HEADERS";\n');
      expect(otelHookSupportsDirectExport(hooksHome)).toBe(true);
    });

    it('rejects a missing install', () => {
      expect(otelHookSupportsDirectExport(hooksHome)).toBe(false);
    });
  });

  describe('direct.env', () => {
    it('URL-encodes the header value (the space is %20)', () => {
      expect(encodeOtlpHeaders({ Authorization: `Basic ${TOKEN}` })).toBe(
        `Authorization=Basic%20${encodeURIComponent(TOKEN)}`,
      );
    });

    it('holds the traces endpoint and headers, logs off, local paths stripped', () => {
      const content = buildDirectExportEnv(langfuse());
      expect(content).toContain("export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT='https://langfuse.example/api/public/otel/v1/traces'");
      expect(content).toContain(`export OTEL_EXPORTER_OTLP_TRACES_HEADERS='Authorization=Basic%20${encodeURIComponent(TOKEN)}'`);
      expect(content).toContain('export OTEL_HOOK_LOGS_ENABLED=false');
      expect(content).toContain('unset OTEL_HOOK_EXPORTER_ENDPOINT OTEL_HOOK_LOGS_ENDPOINT');
      expect(content).toContain(`export ${DIRECT_STRIP_LOCAL_ENV}=1`);
      expect(content).not.toContain('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT');
    });

    it('sends logs only to a destination that subscribes to them', () => {
      const content = buildDirectExportEnv(collector('otel', ['traces', 'logs']));
      expect(content).toContain('export OTEL_HOOK_LOGS_ENABLED=true');
      expect(content).toContain("export OTEL_EXPORTER_OTLP_LOGS_ENDPOINT='http://collector.example:4318/v1/logs'");
      expect(content).toContain("export OTEL_EXPORTER_OTLP_LOGS_HEADERS='x-api-key=abc%20def'");
    });

    it('keeps local paths for a destination that opted in', () => {
      expect(buildDirectExportEnv(langfuse('lf', { includeLocalPaths: true }))).not.toContain(DIRECT_STRIP_LOCAL_ENV);
    });

    it('is written mode 0600 and removed when the route is no longer direct', () => {
      const filePath = writeDirectExportEnv({ mode: 'direct', destination: langfuse() }, hooksHome);
      expect(filePath).toBe(getDirectExportEnvPath(hooksHome));
      expect(fs.statSync(filePath!).mode & 0o777).toBe(0o600);
      expect(readAppliedDirectRoute(hooksHome)).toEqual({ destination: 'langfuse', logs: false, includeLocalPaths: false });
      writeDirectExportEnv({ mode: 'control' }, hooksHome);
      expect(fs.existsSync(getDirectExportEnvPath(hooksHome))).toBe(false);
      expect(readAppliedDirectRoute(hooksHome)).toBeNull();
    });
  });

  describe('hook config and wrapper', () => {
    it('writes no endpoint (it would outrank the standard variables) and no factory.local.*', () => {
      const config = buildOtelHooksConfig({
        route: { mode: 'direct', destination: langfuse() },
        resourceAttributes: 'factory.local.checkout.path=/home/dev/repo,factory.slot.id=1',
      });
      expect(config.exporter.enabled).toBe(true);
      expect(config.exporter.endpoint).toBeUndefined();
      expect(config.exporter.logs.enabled).toBe(false);
      expect(config.exporter.logs.endpoint).toBeUndefined();
      expect(config.privacy.contentMode).toBe('omit');
      expect(config.exporter.resourceAttributes).toEqual({ 'factory.slot.id': '1' });
      expect(JSON.stringify(config)).not.toContain(SECRET_KEY);
      expect(JSON.stringify(config)).not.toContain(TOKEN);
    });

    it('applies the route: config, direct.env, and no drift warning for the logs it leaves off', () => {
      installOtelHook(OTEL_HOOK_DIRECT_MIN_VERSION);
      addTelemetryDestination(langfuse());
      const { decision, configPath } = applyAgentTelemetryRoute(hooksHome);
      expect(decision.route.mode).toBe('direct');
      expect(fs.readFileSync(configPath, 'utf8')).not.toContain('endpoint');
      expect(fs.statSync(getDirectExportEnvPath(hooksHome)).mode & 0o777).toBe(0o600);
      expect(inspectTelemetryDrift(hooksHome).mismatches).toEqual([]);

      writeTelemetryLevel('off');
      applyAgentTelemetryRoute(hooksHome);
      expect(fs.existsSync(getDirectExportEnvPath(hooksHome))).toBe(false);
    });

    it('runs otel-hook with the destination in its environment, never in the wrapper or argv', () => {
      const dump = path.join(tmp, 'dump.json');
      const fakeHook = path.join(tmp, 'fake-otel-hook');
      fs.writeFileSync(
        fakeHook,
        `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ argv: process.argv.slice(2), env: process.env }));\n`,
        { mode: 0o755 },
      );
      const wrapper = writeOtelHooksWrapper(fakeHook, hooksHome);
      writeDirectExportEnv({ mode: 'direct', destination: langfuse() }, hooksHome);

      const script = fs.readFileSync(wrapper, 'utf8');
      expect(script).not.toContain(TOKEN);
      expect(script).not.toContain(SECRET_KEY);
      expect(script).toContain(getDirectExportEnvPath(hooksHome));

      const result = spawnSync('bash', [wrapper, '--provider', 'claude-code'], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH,
          OTEL_RESOURCE_ATTRIBUTES:
            'session.id=s1,factory.slot.id=1, factory.local.checkout.path=/home/dev/repo,factory.local.work_dir=/home/dev/wt',
          OTEL_HOOK_EXPORTER_ENDPOINT: 'http://would-win.example/v1/traces',
        },
      });
      expect(result.status).toBe(0);
      const seen = JSON.parse(fs.readFileSync(dump, 'utf8')) as { argv: string[]; env: Record<string, string> };
      expect(seen.argv.join(' ')).not.toContain(TOKEN);
      expect(seen.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT).toBe('https://langfuse.example/api/public/otel/v1/traces');
      expect(seen.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS).toBe(`Authorization=Basic%20${encodeURIComponent(TOKEN)}`);
      expect(seen.env.OTEL_HOOK_LOGS_ENABLED).toBe('false');
      expect(seen.env.OTEL_HOOK_EXPORTER_ENDPOINT).toBeUndefined();
      expect(seen.env.OTEL_RESOURCE_ATTRIBUTES).toBe('session.id=s1,factory.slot.id=1');

      // Back on Mission Control: nothing sourced, attributes untouched.
      writeDirectExportEnv({ mode: 'control' }, hooksHome);
      spawnSync('bash', [wrapper], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, OTEL_RESOURCE_ATTRIBUTES: 'factory.local.work_dir=/x' },
      });
      const after = JSON.parse(fs.readFileSync(dump, 'utf8')) as { env: Record<string, string> };
      expect(after.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS).toBeUndefined();
      expect(after.env.OTEL_RESOURCE_ATTRIBUTES).toBe('factory.local.work_dir=/x');
    });

    it('keeps OTLP/HTTP protobuf, the only protocol otel-hook exports, for an http/json destination', () => {
      const json = { ...collector('otel'), protocol: 'http/json' as const };
      expect(buildOtelHooksConfig({ route: { mode: 'direct', destination: json } }).exporter.protocol).toBe('http/protobuf');
    });

    it('strips factory.local.* from a resource attributes value', () => {
      expect(stripLocalResourceAttributes('a=1,factory.local.x=/p, factory.local.y=/q,b=2')).toBe('a=1,b=2');
    });
  });

  describe('agent session env', () => {
    const attrs = { sessionKey: 'feat-x', agentId: 2, repoPath: '/home/dev/repo', workDir: '/home/dev/wt', repositoryUrl: 'https://github.com/o/r' };

    it('leaves factory.local.* out when asked', () => {
      const value = buildOtelResourceAttributes(attrs, { omitLocalPaths: true });
      expect(value).not.toContain('factory.local.');
      expect(value).toContain('factory.slot.id=2');
    });

    it('leaves factory.local.* out of .env.agent while agents export directly', () => {
      expect(buildTelemetryEnvBlock(attrs)).toContain('factory.local.');
      writeDirectExportEnv({ mode: 'direct', destination: langfuse() }, hooksHome);
      expect(buildTelemetryEnvBlock(attrs)).not.toContain('factory.local.');
      writeDirectExportEnv({ mode: 'direct', destination: langfuse('lf', { includeLocalPaths: true }) }, hooksHome);
      expect(buildTelemetryEnvBlock(attrs)).toContain('factory.local.');
    });
  });

  describe('har telemetry status', () => {
    const runStatus = async (args: string[]): Promise<string> => {
      const chunks: string[] = [];
      const out = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
      });
      const err = jest.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => {
        chunks.push(parts.map(String).join(' '));
      });
      try {
        await yargs(['telemetry', 'status', ...args]).command(telemetryCommand).parseAsync();
        for (let waited = 0; waited < 5000 && !chunks.some((chunk) => chunk.includes('Agent traces') || chunk.includes('agentTraces')); waited += 20) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      } finally {
        out.mockRestore();
        err.mockRestore();
      }
      return chunks.join('\n');
    };

    it('shows the direct mode by destination name, without secrets', async () => {
      installOtelHook(OTEL_HOOK_DIRECT_MIN_VERSION);
      addTelemetryDestination(langfuse());
      applyAgentTelemetryRoute(hooksHome);

      const json = await runStatus(['--json']);
      const parsed = JSON.parse(json) as { agentTraces: { mode: string; label: string; destination: string } };
      expect(parsed.agentTraces).toMatchObject({ mode: 'direct', label: 'direct → langfuse', destination: 'langfuse' });
      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain(SECRET_KEY);

      const text = await runStatus([]);
      expect(text).toContain('Agent traces:  direct → langfuse');
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain('nobody receives');
    });
  });
});
