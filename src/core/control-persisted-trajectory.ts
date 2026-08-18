import * as path from 'path';
import type { AgentTrajectoryRecord } from '../harness/schema';
import { AgentTrajectoryRecordSchema } from '../harness/schema';
import { selectSince } from './portal-watermark';

const FETCH_TIMEOUT_MS = 5000;

export interface PersistedSpanRow {
  sessionKey: string;
  agentId: number;
  agentTool: string;
  workUnitId?: string | null;
  attemptId?: string | null;
  traceId: string;
  spanId: string;
  parentSpanId?: string | null;
  name: string;
  startTime: string;
  endTime?: string | null;
  attributes?: Record<string, unknown> | null;
  createdAt?: string | null;
}

export interface PortalSpan {
  sessionKey: string;
  agentId: number;
  agentTool: string;
  workUnitId?: string;
  attemptId?: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: string;
  endTime?: string;
  attributes?: Record<string, unknown>;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function resolveControlRepoId(apiUrl: string, repoPath: string): Promise<string | null> {
  const repos = await getJson<{ id: string; path: string }[]>(`${apiUrl}/api/repos`);
  if (!Array.isArray(repos)) return null;
  const target = path.resolve(repoPath);
  return repos.find((repo) => path.resolve(repo.path) === target)?.id ?? null;
}

function optional<T>(value: T | null | undefined): T | undefined {
  return value == null ? undefined : value;
}

function toCanonicalRecord(row: Record<string, unknown>): Record<string, unknown> {
  const canonical: Record<string, unknown> = {
    version: row.version,
    source: row.source,
    sourceEventId: row.sourceEventId,
    contentKey: row.contentKey,
    sessionKey: row.sessionKey,
    agentId: row.agentId,
    agentTool: row.agentTool,
    eventType: row.eventType,
    sequence: row.sequence,
    timestamp: row.eventTimestamp ?? row.timestamp,
    payload: row.payload,
    contentKind: row.contentKind,
    contentDisclosure: row.contentDisclosure,
  };
  for (const key of [
    'contentLabel',
    'traceId',
    'spanId',
    'parentSpanId',
    'generationId',
    'toolCallId',
    'correlationId',
    'workUnitId',
    'attemptId',
  ]) {
    if (row[key] != null) canonical[key] = row[key];
  }
  return canonical;
}

function toPortalSpan(row: PersistedSpanRow): PortalSpan {
  return {
    sessionKey: row.sessionKey,
    agentId: row.agentId,
    agentTool: row.agentTool,
    ...(optional(row.workUnitId) !== undefined ? { workUnitId: row.workUnitId as string } : {}),
    ...(optional(row.attemptId) !== undefined ? { attemptId: row.attemptId as string } : {}),
    traceId: row.traceId,
    spanId: row.spanId,
    ...(optional(row.parentSpanId) !== undefined
      ? { parentSpanId: row.parentSpanId as string }
      : {}),
    name: row.name,
    startTime: row.startTime,
    ...(optional(row.endTime) !== undefined ? { endTime: row.endTime as string } : {}),
    ...(row.attributes ? { attributes: row.attributes } : {}),
  };
}

export interface PersistedTrajectoryRequest {
  records: { since: string | null } | false;
  spans: { since: string | null } | false;
}

export interface PersistedTrajectory {
  records: AgentTrajectoryRecord[];
  spans: PortalSpan[];
  recordsMaxSyncedAt: string | null;
  spansMaxSyncedAt: string | null;
}

export async function fetchPersistedTrajectory(
  repoPath: string,
  apiUrl: string,
  request: PersistedTrajectoryRequest,
): Promise<PersistedTrajectory> {
  const empty: PersistedTrajectory = {
    records: [],
    spans: [],
    recordsMaxSyncedAt: null,
    spansMaxSyncedAt: null,
  };
  if (!request.records && !request.spans) return empty;

  const repoId = await resolveControlRepoId(apiUrl, repoPath);
  if (!repoId) return empty;

  const [trajectoryResponse, spansResponse] = await Promise.all([
    request.records
      ? getJson<{ records: (Record<string, unknown> & { createdAt?: string })[] }>(
          `${apiUrl}/api/repos/${repoId}/trajectory`,
        )
      : null,
    request.spans
      ? getJson<{ spans: PersistedSpanRow[] }>(`${apiUrl}/api/repos/${repoId}/spans`)
      : null,
  ]);

  const trajectory = selectSince(
    trajectoryResponse?.records ?? [],
    request.records ? request.records.since : null,
    (row) => row.createdAt ?? null,
  );
  const spans = selectSince(
    spansResponse?.spans ?? [],
    request.spans ? request.spans.since : null,
    (row) => row.createdAt ?? null,
  );

  return {
    records: trajectory.selected.flatMap((row) => {
      const parsed = AgentTrajectoryRecordSchema.safeParse(toCanonicalRecord(row));
      return parsed.success ? [parsed.data] : [];
    }),
    spans: spans.selected.map(toPortalSpan),
    recordsMaxSyncedAt: trajectory.maxSyncedAt,
    spansMaxSyncedAt: spans.maxSyncedAt,
  };
}
