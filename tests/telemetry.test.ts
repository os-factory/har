import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
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

  it('defaults to enabled when preference file is missing', () => {
    expect(readTelemetryPreference()).toEqual({ enabled: true });
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('persists on/off', () => {
    writeTelemetryPreference(false);
    expect(isTelemetryEnabled()).toBe(false);
    expect(fs.existsSync(getTelemetryPreferencePath())).toBe(true);
    writeTelemetryPreference(true);
    expect(isTelemetryEnabled()).toBe(true);
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

  afterEach(() => {
    if (originalTelemetry === undefined) delete process.env.HAR_TELEMETRY;
    else process.env.HAR_TELEMETRY = originalTelemetry;
  });

  it('builds session key from branch', () => {
    expect(buildSessionKey({ branch: 'main-abcd-har-agent-1-xy12', agentId: 1 })).toBe(
      'main-abcd-har-agent-1-xy12',
    );
  });

  it('includes har.* resource attributes', () => {
    const attrs = buildOtelResourceAttributes({
      sessionKey: 'main-abcd-har-agent-1-xy12',
      agentId: 1,
      repoPath: '/repo',
      workDir: '/repo/wt',
      branch: 'main-abcd-har-agent-1-xy12',
      suffix: 'xy12',
    });
    expect(attrs).toContain('har.session_key=main-abcd-har-agent-1-xy12');
    expect(attrs).toContain('har.agent_id=1');
    expect(attrs).toContain('har.repo_path=/repo');
  });

  it('omits Claude OTEL exporters when telemetry disabled or otel not ready', () => {
    process.env.HAR_TELEMETRY = '0';
    const block = buildTelemetryEnvBlock(
      {
        sessionKey: 's1',
        agentId: 1,
        repoPath: '/repo',
        workDir: '/repo',
      },
      { otelReady: true },
    );
    expect(block).toContain('HAR_SESSION_KEY=s1');
    expect(block).not.toContain('CLAUDE_CODE_ENABLE_TELEMETRY');
  });

  it('injects Claude OTEL exporters when enabled and ready', () => {
    process.env.HAR_TELEMETRY = '1';
    const block = buildTelemetryEnvBlock(
      {
        sessionKey: 's1',
        agentId: 1,
        repoPath: '/repo',
        workDir: '/repo',
      },
      { otelReady: true },
    );
    expect(block).toContain('CLAUDE_CODE_ENABLE_TELEMETRY=1');
    expect(block).toContain('OTEL_EXPORTER_OTLP_ENDPOINT=');
    expect(block).toContain('/api/otel');
  });

  it('replaces previous telemetry block when appending to env file', () => {
    process.env.HAR_TELEMETRY = '1';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-env-'));
    const envFile = path.join(dir, '.env.agent.1');
    fs.writeFileSync(envFile, 'AGENT_ID=1\n');
    appendTelemetryEnvToFile(
      envFile,
      { sessionKey: 's1', agentId: 1, repoPath: '/r', workDir: '/r' },
      { otelReady: true },
    );
    appendTelemetryEnvToFile(
      envFile,
      { sessionKey: 's2', agentId: 1, repoPath: '/r', workDir: '/r' },
      { otelReady: true },
    );
    const text = fs.readFileSync(envFile, 'utf8');
    expect(text).toContain('HAR_SESSION_KEY=s2');
    expect(text.match(/HAR_SESSION_KEY=/g)?.length).toBe(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
