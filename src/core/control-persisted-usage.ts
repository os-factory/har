import * as path from 'path';
import type { AgentSessionEvent, AgentSessionUsage, AgentTool, UsageSource } from '../harness/schema';

const FETCH_TIMEOUT_MS = 3000;

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
  firstSeenAt: string;
  lastSeenAt: string;
}

interface PersistedEventRow {
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

/**
 * Best-effort read of persisted telemetry from a locally-reachable Mission
 * Control. Returns empty when the control API is unreachable or the repo is not
 * registered there, so a portal sync always falls back to the live-slot
 * harvest. Never throws.
 */
export async function fetchPersistedPortalTelemetry(
  repoPath: string,
  apiUrl: string,
): Promise<{ usage: AgentSessionUsage[]; events: AgentSessionEvent[] }> {
  const repoId = await resolveControlRepoId(apiUrl, repoPath);
  if (!repoId) return { usage: [], events: [] };

  const [usageResponse, eventsResponse] = await Promise.all([
    getJson<{ usage: PersistedUsageRow[] }>(`${apiUrl}/api/repos/${repoId}/usage`),
    getJson<{ events: PersistedEventRow[] }>(`${apiUrl}/api/repos/${repoId}/events`),
  ]);

  return {
    usage: (usageResponse?.usage ?? []).map(normalizeUsage),
    events: (eventsResponse?.events ?? []).map(normalizeEvent),
  };
}
