import * as fs from 'fs';
import * as path from 'path';
import { getControlApiUrl } from './control-config';

export interface TelemetrySessionAttrs {
  sessionKey: string;
  agentId: number;
  repoPath: string;
  workDir: string;
  branch?: string;
  suffix?: string;
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

/**
 * Session attribution for .env.agent.<id>.
 * Agent OTEL export is owned by opentelemetry-hooks (har telemetry on) — not Claude/Codex native exporters.
 */
export function buildTelemetryEnvBlock(attrs: TelemetrySessionAttrs): string {
  const apiUrl = getControlApiUrl().replace(/\/$/, '');
  const lines: string[] = [
    '',
    '# HAR session attribution (generated)',
    `HAR_SESSION_KEY=${attrs.sessionKey}`,
    `HAR_CONTROL_API_URL=${apiUrl}`,
    `OTEL_RESOURCE_ATTRIBUTES=${buildOtelResourceAttributes(attrs)}`,
    '# Agent telemetry: opentelemetry-hooks → Mission Control (har telemetry on|off)',
  ];
  return lines.join('\n') + '\n';
}

const TELEMETRY_MARKER_START = '# HAR session attribution (generated)';
const TELEMETRY_MARKER_END = '# end HAR telemetry';

export function appendTelemetryEnvToFile(
  envFilePath: string,
  attrs: TelemetrySessionAttrs,
): void {
  const block = buildTelemetryEnvBlock(attrs).trimEnd() + `\n${TELEMETRY_MARKER_END}\n`;

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
