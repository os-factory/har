import type { DoctorFinding, DoctorReport } from '../harness/doctor';
import type { HarDestination } from '../harness/schema';
import {
  checkReceiverCapabilities,
  getIngestQueueRoot,
  resolveQueueReceiver,
  summarizeIngestQueue,
  summarizeIngestQueues,
  type CapabilitiesCheck,
  type IngestQueueSummary,
} from './ingest-queue';
import { hqStatusHint } from './hq-upgrade';
import { readDestinations } from './telemetry-destinations';
import { formatAgo } from './telemetry-health';
import { isControlAvailable } from './telemetry-route';

/**
 * Health of each destination's records / proofs / evidence queue (ADR 0005
 * section 6): depth, last success, last error, and, for `har env doctor`,
 * whether the receiver speaks ingest v2 (`GET v2/capabilities`).
 */

export interface IngestDestinationHealth {
  name: string;
  preset?: HarDestination['preset'];
  queue: IngestQueueSummary;
  capabilities?: CapabilitiesCheck;
  /** Why it is not sent to now (no key, Mission Control not set up), when that is the case. */
  blocked?: string;
  status: 'pass' | 'warn';
  /** One line, never a URL or header value. */
  summary: string;
}

export interface IngestHealthReport {
  status: 'pass' | 'warn' | 'skip';
  destinations: IngestDestinationHealth[];
  notes: string[];
  /** Machine-level findings: a hosted receiver key with no `hq` destination. */
  findings?: DoctorFinding[];
  /** Advisory one-liners that never turn the status (the hosted receiver's full experience). */
  hints?: string[];
}

export interface CollectIngestHealthOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
  /** `GET v2/capabilities` of each receiver (doctor). */
  checkCapabilities?: boolean;
  fetchImpl?: typeof fetch;
  /** Destination list override (tests). */
  destinations?: readonly HarDestination[];
  /** Mission Control set up (tests). */
  controlAvailable?: boolean;
}

function emptySummary(name: string): IngestQueueSummary {
  return { destination: name, queued: { records: 0, proofs: 0, evidence: 0 }, depth: 0, bytes: 0, dead: 0 };
}

function describe(health: Omit<IngestDestinationHealth, 'summary' | 'status'>, now: number): string {
  const { queue } = health;
  const parts: string[] = [];
  if (queue.depth === 0) parts.push('nothing queued');
  else {
    const kinds = (['records', 'proofs', 'evidence'] as const)
      .filter((kind) => queue.queued[kind] > 0)
      .map((kind) => `${kind} ${queue.queued[kind]}`);
    parts.push(`${queue.depth} queued (${kinds.join(', ')})`);
  }
  parts.push(queue.lastSuccessAt ? `last success ${formatAgo(queue.lastSuccessAt, now)}` : 'no success yet');
  if (queue.lastErrorAt && queue.lastError && (!queue.lastSuccessAt || queue.lastErrorAt >= queue.lastSuccessAt)) {
    parts.push(`last error ${formatAgo(queue.lastErrorAt, now)} (${queue.lastError})`);
  }
  if (queue.dead > 0) parts.push(`${queue.dead} rejected in dead/`);
  if (health.blocked) parts.push(health.blocked);
  if (health.capabilities) parts.push(health.capabilities.detail);
  return `${health.name}: ${parts.join(', ')}`;
}

/** Ingest queue health per destination. Never throws. */
export async function collectIngestHealth(options: CollectIngestHealthOptions = {}): Promise<IngestHealthReport> {
  try {
    const env = options.env ?? process.env;
    const now = options.now ?? Date.now();
    const root = getIngestQueueRoot(env);
    let list: readonly HarDestination[];
    try {
      list = options.destinations ?? readDestinations(env).destinations;
    } catch (err) {
      return { status: 'warn', destinations: [], notes: [err instanceof Error ? err.message : String(err)] };
    }
    const receivers = list.filter(
      (destination) =>
        destination.enabled &&
        (destination.preset === 'mission-control' || destination.preset === 'hq') &&
        (destination.records || destination.proofs || destination.evidence),
    );
    const queues = new Map((root ? summarizeIngestQueues(env) : []).map((summary) => [summary.destination, summary]));
    const names = [...new Set([...receivers.map((destination) => destination.name), ...queues.keys()])];
    const out: IngestDestinationHealth[] = [];
    for (const name of names) {
      const destination = receivers.find((entry) => entry.name === name);
      const queue = queues.get(name) ?? (root ? summarizeIngestQueue(root, name) : emptySummary(name));
      let blocked: string | undefined;
      let capabilities: CapabilitiesCheck | undefined;
      if (!destination) {
        blocked = 'no longer an enabled receiver: its queue is dropped on the next drain';
      } else if (
        destination.preset === 'mission-control' &&
        !(options.controlAvailable ?? (env.HAR_CONTROL_DISABLED !== 'true' && isControlAvailable(env)))
      ) {
        blocked = 'Mission Control is not set up (har control up)';
      } else {
        const receiver = resolveQueueReceiver(name, env, list);
        if (receiver !== 'withdrawn' && 'error' in receiver) blocked = receiver.error;
        else if (receiver !== 'withdrawn' && options.checkCapabilities) {
          capabilities = await checkReceiverCapabilities(receiver, {
            env,
            ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
          });
        }
      }
      const base = { name, ...(destination ? { preset: destination.preset } : {}), queue, ...(blocked ? { blocked } : {}), ...(capabilities ? { capabilities } : {}) };
      const lastErrorNewer =
        queue.lastErrorAt !== undefined && (!queue.lastSuccessAt || queue.lastErrorAt >= queue.lastSuccessAt);
      const warn =
        (capabilities !== undefined && !capabilities.ok) ||
        (blocked !== undefined && queue.depth > 0) ||
        (queue.depth > 0 && lastErrorNewer) ||
        queue.dead > 0;
      out.push({ ...base, status: warn ? 'warn' : 'pass', summary: describe(base, now) });
    }
    // Informational only: logged out of HAR HQ by the 2.0 upgrade, or nothing chosen to send there.
    const hint = hqStatusHint(env);
    return {
      status: out.length === 0 ? 'skip' : out.some((entry) => entry.status === 'warn') ? 'warn' : 'pass',
      destinations: out,
      notes: root ? [] : ['no queue directory (test runner)'],
      ...(hint ? { hints: [hint] } : {}),
    };
  } catch (err) {
    return { status: 'skip', destinations: [], notes: [`ingest health not read: ${err instanceof Error ? err.message : String(err)}`] };
  }
}

/** Add an `ingest-destinations` check to a doctor report. Warnings only: a receiver being down never fails the harness. */
export function withIngestHealth(report: DoctorReport, health: IngestHealthReport): DoctorReport {
  const findings: DoctorFinding[] = health.destinations
    .filter((destination) => destination.status === 'warn')
    .map((destination) => ({
      check: 'ingest-destinations',
      severity: 'warning',
      message: destination.summary,
      remedy:
        destination.capabilities && !destination.capabilities.v2
          ? 'The receiver does not support ingest v2 yet: upgrade it (Mission Control: har control up). Records stay queued until then.'
          : 'Check the receiver, then har telemetry flush (queued records, proofs and evidence are also retried on every har command)',
    }));
  findings.push(...(health.findings ?? []));
  return {
    ...report,
    checks: [
      ...report.checks,
      {
        id: 'ingest-destinations',
        label: `records, proofs and evidence destinations${health.notes.length > 0 ? ` (${health.notes.join('; ')})` : ''}`,
        status: health.status === 'skip' ? 'skip' : findings.length > 0 ? 'warn' : 'pass',
      },
    ],
    findings: [...report.findings, ...findings],
    ...(health.hints && health.hints.length > 0 ? { hints: [...(report.hints ?? []), ...health.hints] } : {}),
  };
}
