import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildClaudeNativeTelemetryEnv,
  disableClaudeNativeTelemetry,
  enableClaudeNativeTelemetry,
} from '../src/core/claude-native-telemetry';

let dir: string;
let settingsPath: string;
let hooksHome: string;

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-claude-native-'));
  settingsPath = path.join(dir, '.claude', 'settings.json');
  hooksHome = path.join(dir, '.har', 'otel-hooks');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('buildClaudeNativeTelemetryEnv', () => {
  it('exports cumulative JSON metrics and per-request JSON log events to Mission Control', () => {
    expect(buildClaudeNativeTelemetryEnv('http://localhost:3847/')).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_METRICS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://localhost:3847/api/otel/v1/metrics',
      OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'cumulative',
      OTEL_METRIC_EXPORT_INTERVAL: '10000',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://localhost:3847/api/otel/v1/logs',
      OTEL_LOGS_EXPORT_INTERVAL: '5000',
    });
  });

  it('never turns on prompt or tool-content logging', () => {
    const env = buildClaudeNativeTelemetryEnv('http://localhost:3847');
    expect(env).not.toHaveProperty('OTEL_LOG_USER_PROMPTS');
    expect(env).not.toHaveProperty('OTEL_LOG_TOOL_DETAILS');
    expect(Object.keys(env).filter((key) => /PROMPT|TOOL_DETAIL|TOOL_CONTENT/.test(key))).toEqual([]);
  });
});

describe('enableClaudeNativeTelemetry / disableClaudeNativeTelemetry', () => {
  it('merges the env block and keeps hooks and other settings', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ model: 'opus', hooks: { Stop: [] }, env: { FOO: 'bar' } }),
    );

    const result = enableClaudeNativeTelemetry({
      apiUrl: 'http://localhost:3847',
      settingsPath,
      hooksHome,
    });

    const settings = readSettings();
    expect(settings.model).toBe('opus');
    expect(settings.hooks).toEqual({ Stop: [] });
    expect(settings.env).toMatchObject({
      FOO: 'bar',
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'http://localhost:3847/api/otel/v1/metrics',
    });
    expect(result.skipped).toEqual([]);
    expect(result.written).toHaveLength(10);
  });

  it('never overwrites a value the user set themselves', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        env: { OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: 'https://collector.example/v1/metrics' },
      }),
    );

    const result = enableClaudeNativeTelemetry({ settingsPath, hooksHome });

    expect(result.skipped).toEqual(['OTEL_EXPORTER_OTLP_METRICS_ENDPOINT']);
    expect((readSettings().env as Record<string, string>).OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe(
      'https://collector.example/v1/metrics',
    );
  });

  it('updates its own keys when the Mission Control URL changes', () => {
    enableClaudeNativeTelemetry({ apiUrl: 'http://localhost:3847', settingsPath, hooksHome });
    const result = enableClaudeNativeTelemetry({
      apiUrl: 'http://localhost:4000',
      settingsPath,
      hooksHome,
    });

    expect(result.skipped).toEqual([]);
    expect(result.written).toEqual([
      'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
      'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
    ]);
    expect((readSettings().env as Record<string, string>).OTEL_EXPORTER_OTLP_METRICS_ENDPOINT).toBe(
      'http://localhost:4000/api/otel/v1/metrics',
    );
  });

  it('adds the logs exporter to a metrics-only install HAR made earlier', () => {
    const metricsOnly = Object.fromEntries(
      Object.entries(buildClaudeNativeTelemetryEnv('http://localhost:3847')).filter(
        ([key]) => !key.includes('LOGS'),
      ),
    );
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ env: metricsOnly }));
    fs.mkdirSync(hooksHome, { recursive: true });
    fs.writeFileSync(path.join(hooksHome, 'claude-env.json'), JSON.stringify({ env: metricsOnly }));

    const result = enableClaudeNativeTelemetry({
      apiUrl: 'http://localhost:3847',
      settingsPath,
      hooksHome,
    });

    expect(result.written.sort()).toEqual(
      [
        'OTEL_LOGS_EXPORTER',
        'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
        'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
        'OTEL_LOGS_EXPORT_INTERVAL',
      ].sort(),
    );
    expect(readSettings().env).toEqual(buildClaudeNativeTelemetryEnv('http://localhost:3847'));
  });

  it('leaves a logs exporter the user chose, and telemetry off keeps it', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { OTEL_LOGS_EXPORTER: 'console' } }));

    const result = enableClaudeNativeTelemetry({ settingsPath, hooksHome });
    expect(result.skipped).toEqual(['OTEL_LOGS_EXPORTER']);

    disableClaudeNativeTelemetry({ settingsPath, hooksHome });
    expect(readSettings().env).toEqual({ OTEL_LOGS_EXPORTER: 'console' });
  });

  it('drops a key HAR wrote earlier and no longer manages', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { HAR_OLD_KEY: 'x', MINE: 'y' } }));
    fs.mkdirSync(hooksHome, { recursive: true });
    fs.writeFileSync(
      path.join(hooksHome, 'claude-env.json'),
      JSON.stringify({ env: { HAR_OLD_KEY: 'x', MINE: 'changed-by-user-later' } }),
    );

    enableClaudeNativeTelemetry({ settingsPath, hooksHome });

    const env = readSettings().env as Record<string, string>;
    expect(env).not.toHaveProperty('HAR_OLD_KEY');
    expect(env.MINE).toBe('y');
  });

  it('telemetry off removes only the keys HAR wrote', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ model: 'opus', env: { FOO: 'bar' } }));
    enableClaudeNativeTelemetry({ settingsPath, hooksHome });

    const removed = disableClaudeNativeTelemetry({ settingsPath, hooksHome });

    expect(removed).toHaveLength(10);
    expect(readSettings()).toEqual({ model: 'opus', env: { FOO: 'bar' } });
  });

  it('telemetry off is a no-op when HAR never configured Claude', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' } }));
    expect(disableClaudeNativeTelemetry({ settingsPath, hooksHome })).toEqual([]);
    expect(readSettings()).toEqual({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1' } });
  });
});
