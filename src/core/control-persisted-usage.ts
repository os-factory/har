import type { AgentSessionEvent, AgentSessionUsage, AgentTool, UsageSource } from '../harness/schema';
import { selectSince } from './portal-watermark';
import {
  ChannelReadFailure,
  readControlJson,
  readControlPages,
  resolveControlRepoId,
} from './control-api-read';

interface PersistedUsageRow {
  sessionKey: string;
  agentId: number;
  agentTool: string;
  workDir?: string | null;
  branch?: string | null;
  suffix?: string | null;
  workUnitId?: string | null;
  attemptId?: string | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  tokensCacheRead?: number | null;
  tokensCacheCreation?: number | null;
  tokensTotal?: number | null;
  costUsd?: number | null;
  modelBreakdown?: Record<string, unknown> | null;
  sources?: unknown;
  harvestVersion?: number | null;
  firstSeenAt: string;
  lastSeenAt: string;
  updatedAt?: string | null;
}

export interface PersistedEventRow {
  id?: string;
  sessionKey: string;
  agentId: number;
  agentTool: string;
  eventName: string;
  sequence?: number | null;
  timestamp: string;
  attributes?: Record<string, unknown> | null;
  promptText?: string | null;
  responseText?: string | null;
  rawTruncated?: string | null;
  source?: string | null;
  workUnitId?: string | null;
  attemptId?: string | null;
  createdAt?: string | null;
}

function optionalString(value: string | null | undefined): string | undefined {
  return value == null ? undefined : value;
}

function toSources(value: unknown): UsageSource[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is UsageSource => v === 'otel' || v === 'harvest');
}

function normalizeUsage(row: PersistedUsageRow): AgentSessionUsage {
  return {
    sessionKey: row.sessionKey,
    agentId: row.agentId,
    agentTool: row.agentTool as AgentTool,
    ...(optionalString(row.workDir) !== undefined ? { workDir: row.workDir as string } : {}),
    ...(optionalString(row.branch) !== undefined ? { branch: row.branch as string } : {}),
    ...(optionalString(row.suffix) !== undefined ? { suffix: row.suffix as string } : {}),
    ...(optionalString(row.workUnitId) !== undefined
      ? { workUnitId: row.workUnitId as string }
      : {}),
    ...(optionalString(row.attemptId) !== undefined
      ? { attemptId: row.attemptId as string }
      : {}),
    tokensInput: Number(row.tokensInput ?? 0),
    tokensOutput: Number(row.tokensOutput ?? 0),
    tokensCacheRead: Number(row.tokensCacheRead ?? 0),
    tokensCacheCreation: Number(row.tokensCacheCreation ?? 0),
    tokensTotal: Number(row.tokensTotal ?? 0),
    costUsd: row.costUsd == null ? null : Number(row.costUsd),
    ...(row.modelBreakdown ? { modelBreakdown: row.modelBreakdown } : {}),
    sources: toSources(row.sources),
    harvestVersion: Number(row.harvestVersion ?? 0),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function normalizeEvent(row: PersistedEventRow): AgentSessionEvent {
  return {
    sessionKey: row.sessionKey,
    agentId: row.agentId,
    agentTool: row.agentTool as AgentTool,
    eventName: row.eventName,
    sequence: Number(row.sequence ?? 0),
    timestamp: row.timestamp,
    ...(optionalString(row.workUnitId) !== undefined
      ? { workUnitId: row.workUnitId as string }
      : {}),
    ...(optionalString(row.attemptId) !== undefined
      ? { attemptId: row.attemptId as string }
      : {}),
    ...(row.attributes ? { attributes: row.attributes } : {}),
    promptText: row.promptText ?? null,
    responseText: row.responseText ?? null,
    rawTruncated: row.rawTruncated ?? null,
    source: row.source === 'harvest' ? 'harvest' : 'otel',
  };
}

function maxTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

export interface PersistedPortalTelemetry {
  usage: AgentSessionUsage[];
  events: AgentSessionEvent[];
  maxSyncedAt: string | null;
  failures: ChannelReadFailure[];
  truncated: string[];
}

/**
 * Usage is selected on its cumulative `updatedAt` — a live session that gained
 * tokens re-syncs even though its event time looks old — and events on their
 * append-only `createdAt`, which Mission Control also pages on.
 */
export async function fetchPersistedPortalTelemetry(
  repoPath: string,
  apiUrl: string,
  options?: { since?: string | null },
): Promise<PersistedPortalTelemetry> {
  const empty = { usage: [], events: [], maxSyncedAt: null, failures: [], truncated: [] };

  const repo = await resolveControlRepoId(apiUrl, repoPath);
  if (!repo.ok) {
    return { ...empty, failures: [{ channel: 'repos', reason: repo.error }] };
  }
  if (!repo.data) return empty;

  const since = options?.since ?? null;
  const [usageRead, eventsRead] = await Promise.all([
    readControlJson<{ usage?: PersistedUsageRow[] }>(`${apiUrl}/api/repos/${repo.data}/usage`),
    readControlPages<PersistedEventRow>({
      url: `${apiUrl}/api/repos/${repo.data}/events`,
      since,
      rows: (data) => (data as { events?: PersistedEventRow[] } | null)?.events ?? [],
      cursor: (row) => ({ createdAt: row.createdAt, id: row.id }),
    }),
  ]);

  const failures: ChannelReadFailure[] = [];
  const truncated: string[] = [];
  if (!usageRead.ok) failures.push({ channel: 'usage', reason: usageRead.error });
  if (!eventsRead.ok) failures.push({ channel: 'events', reason: eventsRead.error });
  else if (eventsRead.truncated) truncated.push('events');

  const usage = selectSince(
    usageRead.ok ? (usageRead.data?.usage ?? []) : [],
    since,
    (row) => row.updatedAt ?? row.lastSeenAt,
  );
  const events = selectSince(
    eventsRead.ok ? eventsRead.rows : [],
    since,
    (row) => row.createdAt ?? row.timestamp,
  );

  return {
    usage: usage.selected.map(normalizeUsage),
    events: events.selected.map(normalizeEvent),
    maxSyncedAt: maxTimestamp(usage.maxSyncedAt, events.maxSyncedAt),
    failures,
    truncated,
  };
}
