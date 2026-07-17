import * as fs from 'fs';
import * as path from 'path';
import { getControlApiUrl } from './control-config';
import { getTelemetrySignals, isTelemetryEnabled } from './telemetry-config';

export interface TelemetrySessionAttrs {
  sessionKey: string;
  agentId: number;
  repoPath: string;
  workDir: string;
  branch?: string;
  suffix?: string;
  purpose?: string;
}

function escapeAttrValue(value: string): string {
  return value.replace(/[,=]/g, '_');
}

export function buildOtelResourceAttributes(attrs: TelemetrySessionAttrs): string {
  const parts = [
    `har.session_key=${escapeAttrValue(attrs.sessionKey)}`,
    `har.agent_id=${attrs.agentId}`,
    `har.repo_path=${escapeAttrValue(attrs.repoPath)}`,
    `har.work_dir=${escapeAttrValue(attrs.workDir)}`,
  ];
  if (attrs.branch) parts.push(`har.branch=${escapeAttrValue(attrs.branch)}`);
  if (attrs.suffix) parts.push(`har.suffix=${escapeAttrValue(attrs.suffix)}`);
  if (attrs.purpose) parts.push(`har.purpose=${escapeAttrValue(attrs.purpose)}`);
  return parts.join(',');
}

export function buildSessionKey(input: {
  branch?: string;
  agentId: number;
  suffix?: string;
  createdAt?: string;
}): string {
  if (input.branch) return input.branch;
  const stamp = (input.createdAt ?? new Date().toISOString()).replace(/[:.]/g, '-');
  return `agent-${input.agentId}-${input.suffix ?? stamp}`;
}

/** Env lines for Claude Code / OTEL when telemetry is on and MC is ready. */
export function buildTelemetryEnvBlock(
  attrs: TelemetrySessionAttrs,
  options?: { otelReady?: boolean },
): string {
  const apiUrl = getControlApiUrl().replace(/\/$/, '');
  const lines: string[] = [
    '',
    '# HAR session attribution (generated)',
    `HAR_SESSION_KEY=${attrs.sessionKey}`,
    `HAR_CONTROL_API_URL=${apiUrl}`,
    `OTEL_RESOURCE_ATTRIBUTES=${buildOtelResourceAttributes(attrs)}`,
  ];

  const injectOtel = isTelemetryEnabled() && options?.otelReady !== false;
  if (injectOtel) {
    const signals = getTelemetrySignals();
    lines.push(
      '# HAR telemetry → Mission Control OTLP (disable: har telemetry off)',
      'CLAUDE_CODE_ENABLE_TELEMETRY=1',
      'OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
      `OTEL_EXPORTER_OTLP_ENDPOINT=${apiUrl}/api/otel`,
    );
    if (signals.metrics) {
      lines.push('OTEL_METRICS_EXPORTER=otlp');
    }
    if (signals.logs) {
      lines.push('OTEL_LOGS_EXPORTER=otlp');
    }
    if (signals.prompts) {
      lines.push(
        'OTEL_LOG_USER_PROMPTS=1',
        'OTEL_LOG_ASSISTANT_RESPONSES=1',
      );
    }
    if (signals.traces) {
      lines.push(
        'OTEL_TRACES_EXPORTER=otlp',
        'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1',
      );
    }
  }

  return lines.join('\n') + '\n';
}

const TELEMETRY_MARKER_START = '# HAR session attribution (generated)';
const TELEMETRY_MARKER_END = '# end HAR telemetry';

export function appendTelemetryEnvToFile(
  envFilePath: string,
  attrs: TelemetrySessionAttrs,
  options?: { otelReady?: boolean },
): void {
  const block =
    buildTelemetryEnvBlock(attrs, options).trimEnd() + `\n${TELEMETRY_MARKER_END}\n`;

  let existing = '';
  if (fs.existsSync(envFilePath)) {
    existing = fs.readFileSync(envFilePath, 'utf8');
    const start = existing.indexOf(TELEMETRY_MARKER_START);
    if (start >= 0) {
      const end = existing.indexOf(TELEMETRY_MARKER_END, start);
      if (end >= 0) {
        existing =
          existing.slice(0, start).replace(/\n+$/, '\n') +
          existing.slice(end + TELEMETRY_MARKER_END.length).replace(/^\n+/, '\n');
      } else {
        existing = existing.slice(0, start).replace(/\n+$/, '\n');
      }
    }
  }

  fs.mkdirSync(path.dirname(envFilePath), { recursive: true });
  const combined = (existing.replace(/\n+$/, '\n') + block).replace(/^\n+/, '');
  fs.writeFileSync(envFilePath, combined.endsWith('\n') ? combined : combined + '\n');
}

export function buildCodexOtelSnippet(attrs: TelemetrySessionAttrs): string {
  const apiUrl = getControlApiUrl().replace(/\/$/, '');
  const resource = buildOtelResourceAttributes(attrs);
  return `# Merge into ~/.codex/config.toml (HAR does not overwrite your config)
# Generated for session ${attrs.sessionKey}

[otel]
exporter = "otlp-http"
endpoint = "${apiUrl}/api/otel"
metrics_exporter = "otlp-http"

# Optional: set resource attributes via environment when starting Codex:
# export OTEL_RESOURCE_ATTRIBUTES="${resource}"
# export HAR_SESSION_KEY="${attrs.sessionKey}"
`;
}
