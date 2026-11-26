import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { claudeManagedKeysPath, removeClaudeNativeTelemetry } from '../src/core/claude-native-telemetry';

let dir: string;
let settingsPath: string;
let hooksHome: string;

/** What HAR before 2.0 wrote into the Claude settings `env` block. */
const WRITTEN_BY_OLD_HAR = {
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
};

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
}

function writeOldHarState(settings: Record<string, unknown>, managed: Record<string, string> = WRITTEN_BY_OLD_HAR) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings));
  fs.mkdirSync(hooksHome, { recursive: true });
  fs.writeFileSync(claudeManagedKeysPath(hooksHome), JSON.stringify({ env: managed }));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-claude-native-'));
  settingsPath = path.join(dir, '.claude', 'settings.json');
  hooksHome = path.join(dir, '.har', 'otel-hooks');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('removeClaudeNativeTelemetry', () => {
  it('removes every key an earlier HAR wrote, keeps hooks and other settings', () => {
    writeOldHarState({ model: 'opus', hooks: { Stop: [] }, env: { FOO: 'bar', ...WRITTEN_BY_OLD_HAR } });

    const removed = removeClaudeNativeTelemetry({ settingsPath, hooksHome });

    expect(removed.sort()).toEqual(Object.keys(WRITTEN_BY_OLD_HAR).sort());
    expect(readSettings()).toEqual({ model: 'opus', hooks: { Stop: [] }, env: { FOO: 'bar' } });
    expect(fs.existsSync(claudeManagedKeysPath(hooksHome))).toBe(false);
  });

  it('leaves a key the user changed since HAR wrote it', () => {
    writeOldHarState({
      env: { ...WRITTEN_BY_OLD_HAR, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://collector.example/v1/logs' },
    });

    const removed = removeClaudeNativeTelemetry({ settingsPath, hooksHome });

    expect(removed).not.toContain('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT');
    expect(readSettings().env).toEqual({ OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'https://collector.example/v1/logs' });
  });

  it('drops an env block left empty', () => {
    writeOldHarState({ model: 'opus', env: { ...WRITTEN_BY_OLD_HAR } });

    removeClaudeNativeTelemetry({ settingsPath, hooksHome });

    expect(readSettings()).toEqual({ model: 'opus' });
  });

  it('touches nothing without a record of what HAR wrote', () => {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    const settings = JSON.stringify({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_LOGS_EXPORTER: 'otlp' } });
    fs.writeFileSync(settingsPath, settings);

    expect(removeClaudeNativeTelemetry({ settingsPath, hooksHome })).toEqual([]);
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(settings);
  });

  it('is idempotent and drops the record even without a settings file', () => {
    fs.mkdirSync(hooksHome, { recursive: true });
    fs.writeFileSync(claudeManagedKeysPath(hooksHome), JSON.stringify({ env: WRITTEN_BY_OLD_HAR }));

    expect(removeClaudeNativeTelemetry({ settingsPath, hooksHome })).toEqual([]);
    expect(fs.existsSync(claudeManagedKeysPath(hooksHome))).toBe(false);
    expect(removeClaudeNativeTelemetry({ settingsPath, hooksHome })).toEqual([]);
  });
});
