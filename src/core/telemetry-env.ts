import * as fs from 'fs';
import * as path from 'path';
import { resolveHarnessRoot } from '../harness/manifest';
import {
  LOCAL_CHECKOUT_PATH_ATTR,
  LOCAL_WORK_DIR_ATTR,
  SESSION_ID_ATTR,
  SLOT_ID_ATTR,
} from '../harness/schema';
import { getControlApiUrl } from './control-config';
import { getOtelHooksHome } from './otel-hooks';
import { HAR_RESOURCE_ATTRIBUTES_ENV, readAppliedAgentRoute } from './telemetry-route';
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

/**
 * Work identity keys HAR no longer puts in an agent's environment (ADR 0004
 * section 3): otel-hook stamps them from the session context, segment by
 * segment, so a session that leaves the slot (complete, teardown, another
 * launch) stops reporting it. A value in the environment would outlive the
 * segment, since records outside any segment keep the Resource.
 */
export const AGENT_ENV_OMITTED_IDENTITY_ATTRIBUTES = [
  SLOT_ID_ATTR,
  'factory.work_unit.id',
  'factory.work_unit.source',
  'factory.attempt.id',
] as const;

/**
 * Session Resource attributes for an agent HAR launched: `session.id` (the
 * slot's session key, which otel-hook's own `session.id` overrides on its
 * records), the branch, the repository and the producer, plus the local-only
 * `factory.local.*` paths when every destination opts in. Work identity
 * (`AGENT_ENV_OMITTED_IDENTITY_ATTRIBUTES`: slot, work unit, attempt) comes
 * from the session context only, never from here.
 */
export function buildOtelResourceAttributes(
  attrs: TelemetrySessionAttrs,
  options: { omitLocalPaths?: boolean } = {},
): string {
  const parts = [
    `${SESSION_ID_ATTR}=${escapeAttrValue(attrs.sessionKey)}`,
    ...(options.omitLocalPaths
      ? []
      : [
          `${LOCAL_CHECKOUT_PATH_ATTR}=${escapeAttrValue(attrs.repoPath)}`,
          `${LOCAL_WORK_DIR_ATTR}=${escapeAttrValue(attrs.workDir)}`,
        ]),
  ];
  const omitted = new Set<string>(AGENT_ENV_OMITTED_IDENTITY_ATTRIBUTES);
  parts.push(...factoryCorrelationAttributes(attrs).filter((pair) => !omitted.has(pair.slice(0, pair.indexOf('=')))));
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
 * Factory Commits telemetry-profile correlation attributes (#416). An unknown
 * value is omitted,
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
 * Whether the agent route leaves `factory.local.*` out (`direct.env` written by
 * `har telemetry`): it does unless every destination, Mission Control included,
 * opted in with `includeLocalPaths` (ADR 0004 section 6). No route applied yet
 * strips too. Under a test runner only an explicit `HAR_OTEL_HOOKS_HOME`
 * counts, so unit tests never read a developer's real hooks home.
 */
export function agentRouteOmitsLocalPaths(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.NODE_ENV === 'test' && !env.HAR_OTEL_HOOKS_HOME) return true;
  try {
    const applied = readAppliedAgentRoute(getOtelHooksHome());
    return applied === null || !applied.includeLocalPaths;
  } catch {
    return true;
  }
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
  // The session key travels only as `session.id` in OTEL_RESOURCE_ATTRIBUTES:
  // no HAR_SESSION_KEY, which otel-hook <= 0.6 turns into a `har.session_key`
  // resource attribute.
  const resourceAttributes = quoteShellArg(
    buildOtelResourceAttributes(attrs, { omitLocalPaths: agentRouteOmitsLocalPaths() }),
  );
  const lines: string[] = [
    '',
    '# HAR session attribution (generated)',
    ...(attrs.workUnitId ? [`HAR_WORK_UNIT_ID=${quoteShellArg(attrs.workUnitId)}`] : []),
    ...(attrs.attemptId ? [`HAR_ATTEMPT_ID=${quoteShellArg(attrs.attemptId)}`] : []),
    `HAR_CONTROL_API_URL=${quoteShellArg(apiUrl)}`,
    `OTEL_RESOURCE_ATTRIBUTES=${resourceAttributes}`,
    // Claude Code strips every OTEL_* variable from its hooks (#484); the hook
    // wrapper restores the profile from this copy.
    `${HAR_RESOURCE_ATTRIBUTES_ENV}=${resourceAttributes}`,
    '# Agent telemetry: @osfactory/otel-hook → Mission Control and your destinations (har telemetry on|off)',
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
