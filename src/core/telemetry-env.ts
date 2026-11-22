import * as fs from 'fs';
import * as path from 'path';
import { resolveHarnessRoot } from '../harness/manifest';
import { getControlApiUrl } from './control-config';
import { readGitRemote, sanitizeGitRemoteUrl } from './git-remote';
import { getHarPackageVersion } from './package-version';
import { findWorkUnit } from './work-units';
import { quoteShellArg } from '../utils/shell';

export interface TelemetrySessionAttrs {
  sessionKey: string;
  agentId: number;
  repoPath: string;
  workDir: string;
  branch?: string;
  suffix?: string;
  workUnitId?: string;
  attemptId?: string;
  /** Tracker of the work unit (`github`, `linear`, …) → `factory.work_unit.source`. */
  workUnitSource?: string;
  /** Credential-free repository URL → `vcs.repository.url.full`. */
  repositoryUrl?: string;
  /** HAR version → `factory.producer.version`; defaults to the running package. */
  producerVersion?: string;
}

/** `factory.producer.name` for everything HAR attributes (telemetry profile). */
export const FACTORY_PRODUCER_NAME = 'har';

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
  if (attrs.workUnitId) {
    parts.push(`har.work_unit_id=${escapeAttrValue(attrs.workUnitId)}`);
  }
  if (attrs.attemptId) parts.push(`har.attempt_id=${attrs.attemptId}`);
  parts.push(...factoryCorrelationAttributes(attrs));
  return parts.join(',');
}

function harVersionOrUndefined(): string | undefined {
  try {
    return getHarPackageVersion();
  } catch {
    return undefined;
  }
}

/** The correlation values both agent sessions and verification spans carry. */
export interface FactoryCorrelationInput {
  workUnitId?: string;
  workUnitSource?: string;
  attemptId?: string;
  repositoryUrl?: string;
  branch?: string;
  producerVersion?: string;
}

/**
 * Factory Commits telemetry-profile Resource attributes (#416), emitted
 * alongside the har.* ones with the same values. An unknown value is omitted,
 * never sent as an empty string. The single source for these values: agent
 * sessions (OTEL_RESOURCE_ATTRIBUTES) and verification spans both use it, so a
 * backend can join on them.
 */
export function factoryCorrelationResource(attrs: FactoryCorrelationInput): Record<string, string> {
  const pairs: Array<[string, string | undefined]> = [
    ['factory.work_unit.id', attrs.workUnitId],
    ['factory.work_unit.source', attrs.workUnitSource],
    ['factory.attempt.id', attrs.attemptId],
    ['vcs.repository.url.full', attrs.repositoryUrl],
    ['vcs.ref.head.name', attrs.branch],
    ['factory.producer.name', FACTORY_PRODUCER_NAME],
    ['factory.producer.version', attrs.producerVersion ?? harVersionOrUndefined()],
  ];
  const resource: Record<string, string> = {};
  for (const [key, value] of pairs) {
    const trimmed = value?.trim();
    if (trimmed) resource[key] = escapeAttrValue(trimmed);
  }
  return resource;
}

function factoryCorrelationAttributes(attrs: TelemetrySessionAttrs): string[] {
  return Object.entries(factoryCorrelationResource(attrs)).map(([key, value]) => `${key}=${value}`);
}

/**
 * Fill the correlation values a caller did not pass from the checkout: the
 * origin remote (credentials stripped) and the work unit's tracker. Best
 * effort — a lookup failure leaves the attribute out.
 */
export function withCorrelationDefaults(attrs: TelemetrySessionAttrs): TelemetrySessionAttrs {
  let repositoryUrl = attrs.repositoryUrl;
  if (repositoryUrl === undefined) {
    repositoryUrl = sanitizeGitRemoteUrl(readGitRemote(attrs.repoPath));
  }
  let workUnitSource = attrs.workUnitSource;
  if (workUnitSource === undefined && attrs.workUnitId) {
    try {
      workUnitSource = findWorkUnit(resolveHarnessRoot(attrs.repoPath), attrs.workUnitId)?.source;
    } catch {
      workUnitSource = undefined;
    }
  }
  return {
    ...attrs,
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(workUnitSource ? { workUnitSource } : {}),
  };
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
 * Agent OTEL export is owned by @osfactory/otel-hook (har telemetry on) — not Claude/Codex native exporters.
 */
export function buildTelemetryEnvBlock(input: TelemetrySessionAttrs): string {
  const attrs = withCorrelationDefaults(input);
  const apiUrl = getControlApiUrl().replace(/\/$/, '');
  // Quote every value so the file stays safe to `source` even when a value
  // contains a space or shell metacharacter (e.g. a repo path with a space).
  // quoteShellArg leaves plain tokens unquoted, so ordinary values are unchanged.
  const lines: string[] = [
    '',
    '# HAR session attribution (generated)',
    `HAR_SESSION_KEY=${quoteShellArg(attrs.sessionKey)}`,
    ...(attrs.workUnitId ? [`HAR_WORK_UNIT_ID=${quoteShellArg(attrs.workUnitId)}`] : []),
    ...(attrs.attemptId ? [`HAR_ATTEMPT_ID=${quoteShellArg(attrs.attemptId)}`] : []),
    `HAR_CONTROL_API_URL=${quoteShellArg(apiUrl)}`,
    `OTEL_RESOURCE_ATTRIBUTES=${quoteShellArg(buildOtelResourceAttributes(attrs))}`,
    '# Agent telemetry: @osfactory/otel-hook → Mission Control (har telemetry on|off)',
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
