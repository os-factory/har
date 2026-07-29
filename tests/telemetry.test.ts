import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ensureDefaultTelemetryPreference,
  getTelemetryPreferencePath,
  isTelemetryEnabled,
  readTelemetryPreference,
  writeTelemetryPreference,
} from '../src/core/telemetry-config';
import {
  appendTelemetryEnvToFile,
  buildOtelResourceAttributes,
  buildSessionKey,
  buildTelemetryEnvBlock,
} from '../src/core/telemetry-env';
import {
  buildOtelHooksConfig,
  rewriteHookCommandsToWrapper,
  writeOtelHooksConfig,
  writeOtelHooksWrapper,
} from '../src/core/otel-hooks';

describe('telemetry preference', () => {
  const originalEnv = process.env.HAR_TELEMETRY;
  const originalPath = process.env.HAR_TELEMETRY_CONFIG_PATH;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-telemetry-'));
    process.env.HAR_TELEMETRY_CONFIG_PATH = path.join(tmpDir, 'telemetry.json');
    delete process.env.HAR_TELEMETRY;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.HAR_TELEMETRY;
    else process.env.HAR_TELEMETRY = originalEnv;
    if (originalPath === undefined) delete process.env.HAR_TELEMETRY_CONFIG_PATH;
    else process.env.HAR_TELEMETRY_CONFIG_PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to full telemetry (including prompts) when preference file is missing', () => {
    expect(readTelemetryPreference()).toEqual({
      enabled: true,
      signals: { metrics: true, logs: true, prompts: true, traces: true },
    });
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('persists full defaults on first ensure without overwriting later', () => {
    const first = ensureDefaultTelemetryPreference();
    expect(first.enabled).toBe(true);
    expect(first.signals.prompts).toBe(true);
    expect(fs.existsSync(getTelemetryPreferencePath())).toBe(true);

    writeTelemetryPreference(true, { prompts: false });
    const second = ensureDefaultTelemetryPreference();
    expect(second.signals.prompts).toBe(false);
  });

  it('persists on/off', () => {
    writeTelemetryPreference(false);
    expect(isTelemetryEnabled()).toBe(false);
    expect(fs.existsSync(getTelemetryPreferencePath())).toBe(true);
    writeTelemetryPreference(true, { prompts: true, traces: true });
    expect(isTelemetryEnabled()).toBe(true);
    expect(readTelemetryPreference().signals.prompts).toBe(true);
  });

  it('persists prompt opt-out and defaults traces on', () => {
    writeTelemetryPreference(true, { prompts: false });
    const preference = readTelemetryPreference();
    expect(preference.signals.prompts).toBe(false);
    expect(preference.signals.traces).toBe(true);
    expect(preference.signals.metrics).toBe(true);
    expect(preference.signals.logs).toBe(true);
  });

  it('lets HAR_TELEMETRY override the file', () => {
    writeTelemetryPreference(true);
    process.env.HAR_TELEMETRY = 'off';
    expect(isTelemetryEnabled()).toBe(false);
    process.env.HAR_TELEMETRY = '1';
    expect(isTelemetryEnabled()).toBe(true);
  });
});

describe('telemetry env', () => {
  const originalTelemetry = process.env.HAR_TELEMETRY;
  const originalPath = process.env.HAR_TELEMETRY_CONFIG_PATH;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-telemetry-env-'));
    process.env.HAR_TELEMETRY_CONFIG_PATH = path.join(tmpDir, 'telemetry.json');
    delete process.env.HAR_TELEMETRY;
  });

  afterEach(() => {
    if (originalTelemetry === undefined) delete process.env.HAR_TELEMETRY;
    else process.env.HAR_TELEMETRY = originalTelemetry;
    if (originalPath === undefined) delete process.env.HAR_TELEMETRY_CONFIG_PATH;
    else process.env.HAR_TELEMETRY_CONFIG_PATH = originalPath;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('builds session key from branch', () => {
    expect(buildSessionKey({ branch: 'main-abcd-har-agent-1-xy12', agentId: 1 })).toBe(
      'main-abcd-har-agent-1-xy12',
    );
  });

  it('includes har.* resource attributes without purpose', () => {
    const attrs = buildOtelResourceAttributes({
      sessionKey: 'main-abcd-har-agent-1-xy12',
      agentId: 1,
      repoPath: '/repo',
      workDir: '/repo/wt',
      branch: 'main-abcd-har-agent-1-xy12',
      suffix: 'xy12',
      workUnitId: 'ISSUE-123',
      attemptId: '11111111-1111-4111-8111-111111111111',
    });
    expect(attrs).toContain('har.session_key=main-abcd-har-agent-1-xy12');
    expect(attrs).toContain('har.agent_id=1');
    expect(attrs).toContain('har.repo_path=/repo');
    expect(attrs).toContain('har.work_unit_id=ISSUE-123');
    expect(attrs).toContain('har.attempt_id=11111111-1111-4111-8111-111111111111');
    expect(attrs).not.toContain('har.purpose');
  });

  it('writes session attribution without Claude native OTEL exporters', () => {
    process.env.HAR_TELEMETRY = '1';
    const block = buildTelemetryEnvBlock({
      sessionKey: 's1',
      agentId: 1,
      repoPath: '/repo',
      workDir: '/repo',
    });
    expect(block).toContain('HAR_SESSION_KEY=s1');
    expect(block).toContain('OTEL_RESOURCE_ATTRIBUTES=');
    expect(block).toContain('@osfactory/otel-hook');
    expect(block).not.toContain('CLAUDE_CODE_ENABLE_TELEMETRY');
    expect(block).not.toContain('OTEL_METRICS_EXPORTER');
    expect(block).not.toContain('OTEL_LOGS_EXPORTER');
    expect(block).not.toContain('OTEL_TRACES_EXPORTER');
  });

  it('replaces previous telemetry block when appending to env file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-env-'));
    const envFile = path.join(dir, '.env.agent.1');
    fs.writeFileSync(envFile, 'AGENT_ID=1\n');
    appendTelemetryEnvToFile(envFile, {
      sessionKey: 's1',
      agentId: 1,
      repoPath: '/r',
      workDir: '/r',
    });
    appendTelemetryEnvToFile(envFile, {
      sessionKey: 's2',
      agentId: 1,
      repoPath: '/r',
      workDir: '/r',
    });
    const text = fs.readFileSync(envFile, 'utf8');
    expect(text).toContain('HAR_SESSION_KEY=s2');
    expect(text.match(/HAR_SESSION_KEY=/g)?.length).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('otel hooks config', () => {
  const originalTelemetry = process.env.HAR_TELEMETRY;
  const originalPath = process.env.HAR_TELEMETRY_CONFIG_PATH;
  const originalControl = process.env.HAR_CONTROL_API_URL;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-otel-hooks-'));
    process.env.HAR_TELEMETRY_CONFIG_PATH = path.join(tmpDir, 'telemetry.json');
    process.env.HAR_CONTROL_API_URL = 'http://localhost:3847';
    delete process.env.HAR_TELEMETRY;
  });

  afterEach(() => {
    if (originalTelemetry === undefined) delete process.env.HAR_TELEMETRY;
    else process.env.HAR_TELEMETRY = originalTelemetry;
    if (originalPath === undefined) delete process.env.HAR_TELEMETRY_CONFIG_PATH;
    else process.env.HAR_TELEMETRY_CONFIG_PATH = originalPath;
    if (originalControl === undefined) delete process.env.HAR_CONTROL_API_URL;
    else process.env.HAR_CONTROL_API_URL = originalControl;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('maps HAR signals to @osfactory/otel-hook config with protobuf endpoint', () => {
    writeTelemetryPreference(true);
    const config = buildOtelHooksConfig({ enabled: true, apiUrl: 'http://localhost:3847' });
    expect(config.exporter.endpoint).toBe('http://localhost:3847/api/otel/v1/traces');
    expect(config.exporter.protocol).toBe('http/protobuf');
    expect(config.exporter.enabled).toBe(true);
    expect(config.exporter.logs.enabled).toBe(true);
    expect(config.exporter.logs.includeContent).toBe(true);
    expect(config.privacy.contentMode).toBe('raw');
    expect(config.privacy.allowRawContent).toBe(true);
  });

  it('disables prompt capture when prompts signal is off', () => {
    writeTelemetryPreference(true, { prompts: false });
    const config = buildOtelHooksConfig({ enabled: true, apiUrl: 'http://localhost:3847' });
    expect(config.privacy.contentMode).toBe('omit');
    expect(config.privacy.allowRawContent).toBe(false);
    expect(config.exporter.logs.includeContent).toBe(false);
  });

  it('disables exporter when telemetry is off', () => {
    const config = buildOtelHooksConfig({ enabled: false, apiUrl: 'http://localhost:3847' });
    expect(config.exporter.enabled).toBe(false);
    expect(config.exporter.endpoint).toBeUndefined();
    expect(config.privacy.contentMode).toBe('omit');
  });

  it('writes config JSON under hooks home', () => {
    const hooksHome = path.join(tmpDir, 'hooks');
    const configPath = writeOtelHooksConfig(
      buildOtelHooksConfig({ enabled: true, apiUrl: 'http://localhost:3847' }),
      hooksHome,
    );
    expect(configPath).toBe(path.join(hooksHome, 'otel_config.json'));
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      exporter: { protocol: string };
    };
    expect(parsed.exporter.protocol).toBe('http/protobuf');
  });

  it('rewrites hooks.json commands to the HAR wrapper', () => {
    const hooksFile = path.join(tmpDir, 'hooks.json');
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [{ command: 'otel-hook', timeout: 5 }],
        },
      }),
    );
    const wrapper = '/tmp/har-run-otel-hook.sh';
    expect(rewriteHookCommandsToWrapper(hooksFile, wrapper)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as {
      hooks: { sessionStart: Array<{ command: string }> };
    };
    expect(parsed.hooks.sessionStart[0].command).toBe(wrapper);
  });

  it('upgrades a copied Python hook command to the HAR wrapper', () => {
    const hooksFile = path.join(tmpDir, 'legacy-hooks.json');
    fs.writeFileSync(
      hooksFile,
      JSON.stringify({
        version: 1,
        hooks: {
          sessionStart: [
            {
              command:
                'python3 /repo/.cursor/hooks/opentelemetry-hook/otel_hook.py --cursor',
            },
          ],
        },
      }),
    );
    const wrapper = '/tmp/har-run-otel-hook.sh';
    expect(rewriteHookCommandsToWrapper(hooksFile, wrapper)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(hooksFile, 'utf8')) as {
      hooks: { sessionStart: Array<{ command: string }> };
    };
    expect(parsed.hooks.sessionStart[0].command).toBe(`${wrapper} --provider cursor`);
  });

  it('writes a wrapper that invokes the TypeScript CLI with HAR paths', () => {
    const hooksHome = path.join(tmpDir, 'hooks');
    const binary = path.join(hooksHome, 'node_modules', '.bin', 'otel-hook');
    const wrapper = writeOtelHooksWrapper(binary, hooksHome);
    const script = fs.readFileSync(wrapper, 'utf8');
    expect(script).toContain(`exec "${binary}" run`);
    expect(script).toContain(`--config-file "${path.join(hooksHome, 'otel_config.json')}"`);
    expect(script).toContain(`--state-dir "${path.join(hooksHome, 'state')}"`);
    expect(script).not.toContain('python');
    expect(fs.statSync(wrapper).mode & 0o111).not.toBe(0);
  });
});
