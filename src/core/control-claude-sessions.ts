import type { AgentSessionUsage } from '../harness/schema';
import { readControlPages } from './control-api-read';
import {
  harvestClaudeUsageForSessions,
  type AttributedClaudeSession,
} from './usage-harvest/claude-sessions';

interface SpanRow {
  id?: string | null;
  createdAt?: string | null;
  sessionKey?: string | null;
  agentId?: number | null;
  agentTool?: string | null;
  workUnitId?: string | null;
  attemptId?: string | null;
  attributes?: Record<string, unknown> | null;
}

export interface SlotAttribution {
  agentId: number;
  workDir?: string;
  branch?: string;
  suffix?: string;
}

function spanRows(data: unknown): SpanRow[] {
  const spans = (data as { spans?: unknown } | null)?.spans;
  return Array.isArray(spans) ? (spans as SpanRow[]) : [];
}

/**
 * Claude sessions Mission Control has spans for in this repo, one entry per
 * `session.id`, carrying the slot and `sessionKey` ingest resolved for them.
 *
 * The first span seen for a session wins: ingest pins a session to the agent id
 * of its first event, so later spans agree with it.
 */
export async function fetchAttributedClaudeSessions(
  apiUrl: string,
  repoId: string,
  slots: SlotAttribution[] = [],
): Promise<{ ok: true; sessions: AttributedClaudeSession[]; truncated: boolean } | { ok: false; error: string }> {
  const read = await readControlPages<SpanRow>({
    url: `${apiUrl}/api/repos/${repoId}/spans`,
    since: null,
    rows: spanRows,
    cursor: (row) => ({ createdAt: row.createdAt ?? null, id: row.id ?? null }),
  });
  if (!read.ok) return read;

  const slotById = new Map(slots.map((slot) => [slot.agentId, slot]));
  const bySession = new Map<string, AttributedClaudeSession>();
  for (const row of read.rows) {
    if (row.agentTool !== 'claude_code') continue;
    const sessionId = row.attributes?.['session.id'];
    if (typeof sessionId !== 'string' || !sessionId || bySession.has(sessionId)) continue;
    if (typeof row.agentId !== 'number' || !row.sessionKey) continue;
    const slot = slotById.get(row.agentId);
    bySession.set(sessionId, {
      sessionId,
      sessionKey: row.sessionKey,
      agentId: row.agentId,
      ...(slot?.workDir ? { workDir: slot.workDir } : {}),
      ...(slot?.branch ? { branch: slot.branch } : {}),
      ...(slot?.suffix ? { suffix: slot.suffix } : {}),
      ...(row.workUnitId ? { workUnitId: row.workUnitId } : {}),
      ...(row.attemptId ? { attemptId: row.attemptId } : {}),
    });
  }
  return { ok: true, sessions: [...bySession.values()], truncated: read.truncated };
}

/**
 * Usage for Claude sessions started outside the slot's work dir (typically the
 * main checkout), attributed to the slot Mission Control linked them to.
 * Sessions whose transcript `cwd` is inside a slot work dir are left to the
 * per-slot harvest.
 */
export async function harvestAttributedClaudeUsage(
  apiUrl: string,
  repoId: string,
  slots: SlotAttribution[],
): Promise<{ usage: AgentSessionUsage[]; warning?: string }> {
  const read = await fetchAttributedClaudeSessions(apiUrl, repoId, slots);
  if (!read.ok) return { usage: [], warning: `Claude session harvest skipped: ${read.error}` };
  const slotWorkspaces = slots
    .map((slot) => slot.workDir)
    .filter((dir): dir is string => Boolean(dir));
  const usage = harvestClaudeUsageForSessions(read.sessions, slotWorkspaces);
  return read.truncated
    ? { usage, warning: 'Claude session harvest read a truncated span list; older sessions were skipped' }
    : { usage };
}
