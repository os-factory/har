import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { DoctorFinding, DoctorReport } from '../harness/doctor';
import { getOtelHooksConfigPath, getOtelHooksHome, getOtelHooksStateDir } from './otel-hooks';
import { isTelemetryEnabled } from './telemetry-config';
import { getRouteEnvPath, planRouteDestinations, resolveAgentTelemetryRoute } from './telemetry-route';
import { summarizeTelemetrySpool, type SpoolReceiverSummary } from './telemetry-spool';

/**
 * Destination health (F3) for `har env doctor` and `har telemetry status`:
 * what each receiver has queued, dropped, and when it last failed, from two
 * sources:
 *
 * - agent traces: `otel-hook doctor --json`, run from the hooks home. It
 *   reports each `exporter.destinations[]` entry's spool (batches, bytes,
 *   drops by reason) and, when the installed otel-hook records them,
 *   `lastFailureAt` / `lastErrorCode`. Header values never appear in it: it
 *   names the variables a header reads, not their values.
 * - verification traces: the CLI's own retry spool (`telemetry-spool.ts`).
 *
 * Local reads only (no request is sent) and bounded: one otel-hook process
 * with a short timeout. Missing otel-hook is a note, never a failure.
 */

/** Budget of the `otel-hook doctor` call. */
const OTEL_HOOK_DOCTOR_TIMEOUT_MS = 5_000;
/** A failure this recent warns even when nothing is queued any more. */
export const RECENT_FAILURE_MS = 60 * 60_000;
/** Drops this recent warn: data was lost. */
export const RECENT_DROP_MS = 24 * 60 * 60_000;

export interface SpoolDropCounts {
  total: number;
  age: number;
  size: number;
  count: number;
  rejected: number;
  lastDroppedAt?: number;
}

/** One receiver's health, both channels merged. Holds names and counts only. */
export interface DestinationHealth {
  /** HAR destination name, or `mission-control`. */
  name: string;
  /** Agent trace/log batches otel-hook has queued for it. */
  agentQueuedBatches: number;
  agentQueuedBytes: number;
  /** Verification traces the CLI has queued for it. */
  verificationQueued: number;
  dropped?: SpoolDropCounts;
  oldestQueuedAt?: number;
  lastFailureAt?: number;
  lastErrorCode?: string;
  /** Header variables otel-hook could not find (names only). */
  missingVariables?: string[];
  status: 'pass' | 'warn';
  /** One line, safe to print: `langfuse: 7 batches queued, last failure 2 min ago (ECONNREFUSED)`. */
  summary: string;
}

export interface TelemetryHealthReport {
  /** `skip` when telemetry is off; `warn` when any receiver needs attention. */
  status: 'pass' | 'warn' | 'skip';
  destinations: DestinationHealth[];
  /** Why a source was not read (otel-hook missing, unreadable output). */
  notes: string[];
}

/** The parts of one `otel-hook doctor --json` destination HAR reads. */
interface OtelHookDoctorDestination {
  name?: unknown;
  ok?: unknown;
  missingVariables?: unknown;
  lastFailureAt?: unknown;
  lastErrorCode?: unknown;
  health?: { lastFailureAt?: unknown; lastErrorCode?: unknown };
  spool?: Record<string, { batches?: unknown; bytes?: unknown; oldestEnqueuedAt?: unknown; dropped?: Record<string, unknown> }>;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** `lastFailureAt` may be epoch ms or an ISO string. */
function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** `just now`, `2 min ago`, `3 h ago`, `2 d ago`. */
export function formatAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export interface AssessTelemetryHealthInput {
  /** Parsed `otel-hook doctor --json`, or null when it could not be read. */
  otelHookReport: unknown;
  /** The CLI spool, per receiver. */
  spool: readonly SpoolReceiverSummary[];
  /** otel-hook destination name → HAR name (`mission-control` included). */
  names?: ReadonlyMap<string, string>;
  now?: number;
  notes?: string[];
}

/** Merge the two sources into one row per receiver and judge each. Pure. */
export function assessTelemetryHealth(input: AssessTelemetryHealthInput): TelemetryHealthReport {
  const now = input.now ?? Date.now();
  const rows = new Map<string, DestinationHealth>();
  const row = (name: string): DestinationHealth => {
    let existing = rows.get(name);
    if (!existing) {
      existing = { name, agentQueuedBatches: 0, agentQueuedBytes: 0, verificationQueued: 0, status: 'pass', summary: '' };
      rows.set(name, existing);
    }
    return existing;
  };

  const report = input.otelHookReport as { destinations?: unknown } | null;
  const destinations = Array.isArray(report?.destinations) ? (report.destinations as OtelHookDoctorDestination[]) : [];
  for (const destination of destinations) {
    if (typeof destination.name !== 'string') continue;
    const target = row(input.names?.get(destination.name) ?? destination.name);
    for (const stats of Object.values(destination.spool ?? {})) {
      target.agentQueuedBatches += num(stats.batches) ?? 0;
      target.agentQueuedBytes += num(stats.bytes) ?? 0;
      target.oldestQueuedAt = minDefined(target.oldestQueuedAt, num(stats.oldestEnqueuedAt));
      const dropped = stats.dropped ?? {};
      const total = num(dropped.total) ?? 0;
      if (total > 0) {
        const previous = target.dropped ?? { total: 0, age: 0, size: 0, count: 0, rejected: 0 };
        target.dropped = {
          total: previous.total + total,
          age: previous.age + (num(dropped.age) ?? 0),
          size: previous.size + (num(dropped.size) ?? 0),
          count: previous.count + (num(dropped.count) ?? 0),
          rejected: previous.rejected + (num(dropped.rejected) ?? 0),
          ...(maxDefined(previous.lastDroppedAt, num(dropped.lastDroppedAt)) !== undefined
            ? { lastDroppedAt: maxDefined(previous.lastDroppedAt, num(dropped.lastDroppedAt)) }
            : {}),
        };
      }
    }
    const lastFailureAt = timestamp(destination.lastFailureAt) ?? timestamp(destination.health?.lastFailureAt);
    const lastErrorCode = destination.lastErrorCode ?? destination.health?.lastErrorCode;
    if (lastFailureAt !== undefined && lastFailureAt >= (target.lastFailureAt ?? 0)) {
      target.lastFailureAt = lastFailureAt;
      if (typeof lastErrorCode === 'string') target.lastErrorCode = lastErrorCode;
    }
    if (Array.isArray(destination.missingVariables) && destination.missingVariables.length > 0) {
      target.missingVariables = destination.missingVariables.filter((name): name is string => typeof name === 'string');
    }
  }

  for (const summary of input.spool) {
    const target = row(summary.receiver);
    target.verificationQueued += summary.batches;
    target.oldestQueuedAt = minDefined(target.oldestQueuedAt, summary.oldestCreatedAt);
    if (summary.lastFailureAt !== undefined && summary.lastFailureAt >= (target.lastFailureAt ?? 0)) {
      target.lastFailureAt = summary.lastFailureAt;
      if (summary.lastError) target.lastErrorCode = summary.lastError;
    }
  }

  for (const target of rows.values()) {
    const parts: string[] = [];
    if (target.agentQueuedBatches > 0) parts.push(`${plural(target.agentQueuedBatches, 'batch', 'batches')} queued`);
    if (target.verificationQueued > 0) parts.push(`${plural(target.verificationQueued, 'verification trace', 'verification traces')} queued`);
    const recentDrop =
      target.dropped !== undefined &&
      target.dropped.lastDroppedAt !== undefined &&
      now - target.dropped.lastDroppedAt <= RECENT_DROP_MS;
    if (recentDrop && target.dropped) {
      const reasons = (['age', 'size', 'count', 'rejected'] as const)
        .filter((reason) => (target.dropped?.[reason] ?? 0) > 0)
        .map((reason) => `${reason} ${target.dropped?.[reason]}`);
      parts.push(`${target.dropped.total} dropped${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}`);
    }
    if (target.missingVariables && target.missingVariables.length > 0) {
      parts.push(`header variable(s) not set: ${target.missingVariables.join(', ')}`);
    }
    const recentFailure = target.lastFailureAt !== undefined && now - target.lastFailureAt <= RECENT_FAILURE_MS;
    const queued = target.agentQueuedBatches + target.verificationQueued > 0;
    if (target.lastFailureAt !== undefined && (queued || recentFailure)) {
      parts.push(`last failure ${formatAgo(target.lastFailureAt, now)}${target.lastErrorCode ? ` (${target.lastErrorCode})` : ''}`);
    } else if (queued && target.oldestQueuedAt !== undefined) {
      parts.push(`oldest queued ${formatAgo(target.oldestQueuedAt, now)}`);
    }
    const unhealthy = queued || recentFailure || recentDrop || (target.missingVariables?.length ?? 0) > 0;
    target.status = unhealthy ? 'warn' : 'pass';
    target.summary = `${target.name}: ${parts.length > 0 ? parts.join(', ') : 'healthy, nothing queued'}`;
  }

  const ordered = [...rows.values()].sort((a, b) =>
    a.name === 'mission-control' ? -1 : b.name === 'mission-control' ? 1 : 0,
  );
  return {
    status: ordered.some((target) => target.status === 'warn') ? 'warn' : 'pass',
    destinations: ordered,
    notes: input.notes ?? [],
  };
}

/** Run `otel-hook doctor --json` from the hooks home, with the route's header variables in its environment. */
export function runOtelHookDoctor(hooksHome = getOtelHooksHome()): { report: unknown } | { note: string } {
  const bin = path.join(hooksHome, 'node_modules', '.bin', 'otel-hook');
  if (!fs.existsSync(bin)) {
    return { note: 'otel-hook is not installed (har telemetry on installs it): agent destination health skipped' };
  }
  const envFile = getRouteEnvPath(hooksHome);
  // The variables are sourced into the doctor's environment only so it can
  // tell set from missing; their values never reach its output or ours.
  const script = 'if [ -f "$1" ]; then . "$1" >/dev/null 2>&1; fi; exec "$2" doctor --json --config-file "$3" --state-dir "$4"';
  const result = spawnSync(
    'bash',
    ['-c', script, 'har-otel-doctor', envFile, bin, getOtelHooksConfigPath(hooksHome), getOtelHooksStateDir(hooksHome)],
    { cwd: hooksHome, encoding: 'utf8', timeout: OTEL_HOOK_DOCTOR_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  if (result.error) return { note: `otel-hook doctor did not run (${result.error.message}): agent destination health skipped` };
  try {
    // Exits 1 when a check fails; the report is still on stdout.
    return { report: JSON.parse(result.stdout ?? '') as unknown };
  } catch {
    return { note: 'otel-hook doctor gave no readable report: agent destination health skipped' };
  }
}

export interface CollectTelemetryHealthOptions {
  hooksHome?: string;
  env?: NodeJS.ProcessEnv;
  now?: number;
  /** Override the otel-hook call (tests). */
  otelHookDoctor?: () => { report: unknown } | { note: string };
}

/** Destination health on this machine. Never throws. */
export function collectTelemetryHealth(options: CollectTelemetryHealthOptions = {}): TelemetryHealthReport {
  try {
    if (!isTelemetryEnabled()) return { status: 'skip', destinations: [], notes: ['telemetry is off'] };
    const hooksHome = options.hooksHome ?? getOtelHooksHome();
    const doctor = (options.otelHookDoctor ?? (() => runOtelHookDoctor(hooksHome)))();
    const names = new Map<string, string>();
    try {
      for (const plan of planRouteDestinations(resolveAgentTelemetryRoute(hooksHome, options.env).route)) {
        names.set(plan.name, plan.destination);
      }
    } catch {
      // unmapped names are shown as otel-hook spells them
    }
    let spool: SpoolReceiverSummary[] = [];
    try {
      spool = summarizeTelemetrySpool(options.env);
    } catch {
      spool = [];
    }
    return assessTelemetryHealth({
      otelHookReport: 'report' in doctor ? doctor.report : null,
      spool,
      names,
      now: options.now,
      notes: 'note' in doctor ? [doctor.note] : [],
    });
  } catch (err) {
    return {
      status: 'skip',
      destinations: [],
      notes: [`destination health not read: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

/**
 * Add a `telemetry-destinations` check to a doctor report. Warnings only: a
 * backend being down never fails the harness contract.
 */
export function withTelemetryHealth(report: DoctorReport, health: TelemetryHealthReport): DoctorReport {
  const findings: DoctorFinding[] = health.destinations
    .filter((destination) => destination.status === 'warn')
    .map((destination) => ({
      check: 'telemetry-destinations',
      severity: 'warning',
      message: destination.summary,
      remedy:
        destination.verificationQueued > 0
          ? 'Check the backend, then har telemetry destination flush (agent batches retry on the next hook event)'
          : 'Check the backend: queued batches are retried on the next hook event',
    }));
  return {
    ...report,
    checks: [
      ...report.checks,
      {
        id: 'telemetry-destinations',
        label: `telemetry destinations${health.notes.length > 0 ? ` (${health.notes.join('; ')})` : ''}`,
        status: health.status === 'skip' ? 'skip' : findings.length > 0 ? 'warn' : 'pass',
      },
    ],
    findings: [...report.findings, ...findings],
  };
}
