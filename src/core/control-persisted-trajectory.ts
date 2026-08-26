import type { AgentTrajectoryRecord } from '../harness/schema';
import { AgentTrajectoryRecordSchema } from '../harness/schema';
import { selectSince } from './portal-watermark';
import {
  ChannelReadFailure,
  readControlPages,
  resolveControlRepoId,
} from './control-api-read';

export interface PersistedSpanRow {
  id?: string;
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

type TrajectoryRow = Record<string, unknown> & { id?: string; createdAt?: string };

export interface PersistedTrajectory {
  records: AgentTrajectoryRecord[];
  spans: PortalSpan[];
  recordsMaxSyncedAt: string | null;
  spansMaxSyncedAt: string | null;
  failures: ChannelReadFailure[];
  truncated: string[];
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
    failures: [],
    truncated: [],
  };
  if (!request.records && !request.spans) return empty;

  const repo = await resolveControlRepoId(apiUrl, repoPath);
  if (!repo.ok) return { ...empty, failures: [{ channel: 'repos', reason: repo.error }] };
  if (!repo.data) return empty;

  const [trajectoryRead, spansRead] = await Promise.all([
    request.records
      ? readControlPages<TrajectoryRow>({
          url: `${apiUrl}/api/repos/${repo.data}/trajectory`,
          since: request.records.since,
          rows: (data) => (data as { records?: TrajectoryRow[] } | null)?.records ?? [],
          cursor: (row) => ({ createdAt: row.createdAt, id: row.id }),
        })
      : null,
    request.spans
      ? readControlPages<PersistedSpanRow>({
          url: `${apiUrl}/api/repos/${repo.data}/spans`,
          since: request.spans.since,
          rows: (data) => (data as { spans?: PersistedSpanRow[] } | null)?.spans ?? [],
          cursor: (row) => ({ createdAt: row.createdAt, id: row.id }),
        })
      : null,
  ]);

  const failures: ChannelReadFailure[] = [];
  const truncated: string[] = [];
  if (trajectoryRead && !trajectoryRead.ok) {
    failures.push({ channel: 'trajectory', reason: trajectoryRead.error });
  } else if (trajectoryRead?.ok && trajectoryRead.truncated) {
    truncated.push('trajectory');
  }
  if (spansRead && !spansRead.ok) failures.push({ channel: 'spans', reason: spansRead.error });
  else if (spansRead?.ok && spansRead.truncated) truncated.push('spans');

  const trajectory = selectSince(
    trajectoryRead?.ok ? trajectoryRead.rows : [],
    request.records ? request.records.since : null,
    (row) => row.createdAt ?? null,
  );
  const spans = selectSince(
    spansRead?.ok ? spansRead.rows : [],
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
    failures,
    truncated,
  };
}
