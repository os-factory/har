import {
  PortalSessionAttributionInputSchema,
  PortalUsageObservationSchema,
  ReportedSessionUsageSchema,
  SessionSlotBindingSchema,
  type PortalSessionAttributionInput,
  type PortalUsageObservation,
  type ReportedSessionUsage,
  type SessionSlotBinding,
} from '../harness/schema';
import { readControlJson, readControlPages, type ChannelReadFailure } from './control-api-read';
import { chunkBySerializedSize } from './sync-batches';
import { selectSince } from './portal-watermark';

/**
 * Session → slot attribution for har-portal (ADR 0003, FE-2058).
 *
 * The portal stores the same facts Mission Control stores — bindings, usage
 * observations, provider-reported session totals — and derives slot usage with
 * the same code (`@osfactory/har/attribution`). It never receives Mission
 * Control's derived per-slot totals: those change when evidence arrives late,
 * and the portal could not lower a number it already took.
 *
 * Mission Control is the one source. The local sync, which runs first, posts
 * the CLI's `launch` / `release` / `workspace` bindings and harvested
 * observations there; otel-hook and the agents' native OTLP land there
 * directly. Nothing is guessed onto a slot on the way.
 */

interface StoredBindingRow extends Record<string, unknown> {
  id?: string;
  createdAt?: string;
}

interface StoredObservationRow extends Record<string, unknown> {
  id?: string;
  updatedAt?: string;
}

export interface MissionControlAttribution {
  /** False when this Mission Control predates ADR 0003 (no change feed): send legacy usage. */
  available: boolean;
  bindings: SessionSlotBinding[];
  observations: Array<Omit<PortalUsageObservation, 'userEmail'>>;
  reportedUsage: ReportedSessionUsage[];
  /** Latest change read; the portal watermark may advance to it. */
  maxSyncedAt: string | null;
  /** A channel hit the page cap: the watermark must not pass the end of what it read. */
  truncatedAt: string | null;
  failures: ChannelReadFailure[];
  truncated: string[];
}

function isNotFound(error: string): boolean {
  return error === 'HTTP 404';
}

function latest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

/** Strip Mission Control's storage columns and keep only rows the contract accepts. */
export function parseStoredBindings(rows: unknown[]): SessionSlotBinding[] {
  const out: SessionSlotBinding[] = [];
  for (const row of rows) {
    const parsed = SessionSlotBindingSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function parseStoredObservations(
  rows: unknown[],
): Array<Omit<PortalUsageObservation, 'userEmail'>> {
  const out: Array<Omit<PortalUsageObservation, 'userEmail'>> = [];
  for (const row of rows) {
    const parsed = PortalUsageObservationSchema.omit({ userEmail: true }).safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export function parseReportedUsage(rows: unknown[]): ReportedSessionUsage[] {
  const out: ReportedSessionUsage[] = [];
  for (const row of rows) {
    const parsed = ReportedSessionUsageSchema.safeParse(row);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * Read the facts Mission Control recorded since `since`: bindings in storage
 * order, observations in change order (a late harvest or a filled-in cost is a
 * change), and every provider-reported session total (one small row per
 * session, re-sent whole).
 */
export async function fetchMissionControlAttribution(
  apiUrl: string,
  repoId: string,
  since: string | null,
): Promise<MissionControlAttribution> {
  const base = `${apiUrl}/api/repos/${repoId}`;
  const [bindingsRead, observationsRead, reportedRead] = await Promise.all([
    readControlPages<StoredBindingRow>({
      url: `${base}/session-bindings`,
      since,
      rows: (data) => (data as { bindings?: StoredBindingRow[] } | null)?.bindings ?? [],
      cursor: (row) => ({ createdAt: row.createdAt, id: row.id }),
    }),
    readControlPages<StoredObservationRow>({
      url: `${base}/usage-observations/changes`,
      since,
      rows: (data) =>
        (data as { observations?: StoredObservationRow[] } | null)?.observations ?? [],
      cursor: (row) => ({ createdAt: row.updatedAt, id: row.id }),
    }),
    readControlJson<{ reportedUsage?: unknown[] }>(`${base}/reported-usage`),
  ]);

  const empty: MissionControlAttribution = {
    available: false,
    bindings: [],
    observations: [],
    reportedUsage: [],
    maxSyncedAt: null,
    truncatedAt: null,
    failures: [],
    truncated: [],
  };
  // No change feed: Mission Control is older than this CLI. The portal then
  // gets the legacy per-slot totals, exactly as before.
  if (!observationsRead.ok && isNotFound(observationsRead.error)) return empty;

  const failures: ChannelReadFailure[] = [];
  if (!bindingsRead.ok) failures.push({ channel: 'session-bindings', reason: bindingsRead.error });
  if (!observationsRead.ok) {
    failures.push({ channel: 'usage-observations', reason: observationsRead.error });
  }
  if (!reportedRead.ok) failures.push({ channel: 'reported-usage', reason: reportedRead.error });
  if (failures.length > 0) return { ...empty, available: true, failures };
  if (!bindingsRead.ok || !observationsRead.ok || !reportedRead.ok) return empty;

  const bindings = selectSince(bindingsRead.rows, since, (row) => row.createdAt ?? '');
  const observations = selectSince(observationsRead.rows, since, (row) => row.updatedAt ?? '');

  const truncated: string[] = [];
  let truncatedAt: string | null = null;
  if (bindingsRead.truncated) {
    truncated.push('session-bindings');
    truncatedAt = earliest(truncatedAt, bindings.maxSyncedAt);
  }
  if (observationsRead.truncated) {
    truncated.push('usage-observations');
    truncatedAt = earliest(truncatedAt, observations.maxSyncedAt);
  }

  return {
    available: true,
    bindings: parseStoredBindings(bindings.selected),
    observations: parseStoredObservations(observations.selected),
    reportedUsage: parseReportedUsage(reportedRead.data?.reportedUsage ?? []),
    maxSyncedAt: latest(bindings.maxSyncedAt, observations.maxSyncedAt),
    truncatedAt,
    failures: [],
    truncated,
  };
}

/**
 * The portal request bodies for one repository: observations carry the member
 * who ran them; bindings and reported totals ride on the first body. Each body
 * is idempotent on its contract keys, so a resend — or a body repeated after a
 * partial failure — changes nothing.
 */
export function buildPortalAttributionBodies(
  repo: { path: string; gitRemote?: string },
  facts: Pick<MissionControlAttribution, 'bindings' | 'observations' | 'reportedUsage'>,
  userEmail: string | undefined,
  maxBytes: number,
): PortalSessionAttributionInput[] {
  const observations = facts.observations.map((observation) => ({
    ...observation,
    ...(userEmail ? { userEmail } : {}),
  }));
  const head = {
    path: repo.path,
    ...(repo.gitRemote ? { gitRemote: repo.gitRemote } : {}),
  };
  const chunks = chunkBySerializedSize(observations, maxBytes);
  const bodies = (chunks.length > 0 ? chunks : [[]]).map((batch, index) =>
    PortalSessionAttributionInputSchema.parse({
      ...head,
      bindings: index === 0 ? facts.bindings : [],
      observations: batch,
      reportedUsage: index === 0 ? facts.reportedUsage : [],
    }),
  );
  return bodies;
}

/** Combine the attribution watermark with the other portal channels'. */
export function combinePortalWatermark(
  otherMax: string | null,
  attribution: Pick<MissionControlAttribution, 'maxSyncedAt' | 'truncatedAt'>,
): string | null {
  const max = latest(otherMax, attribution.maxSyncedAt);
  return attribution.truncatedAt ? earliest(max, attribution.truncatedAt) : max;
}
