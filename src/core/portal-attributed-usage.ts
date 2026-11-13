import { MAIN_CHECKOUT_AGENT_ID } from '../harness/schema';
import type { AgentSessionUsage, AgentTool, UsageSource } from '../harness/schema';

/**
 * Usage for har-portal, as Mission Control attributed and priced it (ADR 0003,
 * FE-2058). The portal never attributes: it stores these rows as they are,
 * and replaces every row of a provider session whenever a sync carries any.
 *
 * Each row is one bucket of one provider session (`providerSessionId`):
 *
 * | Where the usage happened  | `agentId` | `sessionKey`                          |
 * |---------------------------|-----------|---------------------------------------|
 * | main checkout             | 0         | `<session>@main`                      |
 * | a non-slot git worktree   | 0         | `<session>@wt:<branch ?? workDir>`    |
 * | a slot occupancy          | slot      | `<session>@<slot>:<occupancyKey>`     |
 * | provider total, no unit   | 0         | `<session>@reported`                  |
 *
 * Legacy rows (session totals Mission Control stored before attribution, and
 * still counts) travel as stored, without `providerSessionId`.
 */

/** A `GET /api/repos/:id/usage` usage row (`UsageRowView`), JSON-decoded. */
export interface MissionControlUsageRow {
  sessionKey: string;
  agentId: number;
  agentTool: string;
  workDir?: string | null;
  branch?: string | null;
  suffix?: string | null;
  occupancyKey?: string | null;
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
  origin?: 'observations' | 'legacy';
  changedAt?: string | null;
}

/** A `GET /api/repos/:id/usage` unassigned entry (`UnassignedUsageView`), JSON-decoded. */
export interface MissionControlUnassignedRow {
  agentTool: string;
  sessionId: string;
  workDir?: string | null;
  branch?: string | null;
  tokensInput?: number | null;
  tokensOutput?: number | null;
  tokensCacheRead?: number | null;
  tokensCacheCreation?: number | null;
  tokensTotal?: number | null;
  costUsd?: number | null;
  modelBreakdown?: Record<string, unknown> | null;
  sources?: unknown;
  harvestVersion?: number | null;
  itemized?: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  changedAt?: string | null;
}

export interface MissionControlUsageView {
  usage?: MissionControlUsageRow[];
  unassigned?: MissionControlUnassignedRow[];
}

/** A `usage[]` row of the portal's `/api/sync` body. */
export type PortalUsageRow = Omit<
  AgentSessionUsage,
  'agentId' | 'workDir' | 'branch' | 'workUnitId' | 'attemptId'
> & {
  agentId: number;
  workDir?: string | null;
  branch?: string | null;
  workUnitId?: string | null;
  attemptId?: string | null;
  models?: Array<Record<string, unknown>>;
};

/**
 * True when Mission Control serves attributed usage: its usage view has the
 * per-session `unassigned` list (ADR 0003). An older one serves only stored
 * session totals, and the portal then gets the legacy harvested totals.
 */
export function servesAttributedUsage(view: unknown): view is MissionControlUsageView {
  return Array.isArray((view as MissionControlUsageView | null)?.unassigned);
}

function toSources(value: unknown): UsageSource[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is UsageSource => v === 'otel' || v === 'harvest');
}

function modelsFromBreakdown(breakdown: Record<string, unknown> | null | undefined) {
  if (!breakdown) return [];
  return Object.entries(breakdown).map(([model, totals]) => ({
    model,
    ...(totals && typeof totals === 'object' ? totals : {}),
  }));
}

/** Tokens, cost, models and sources exactly as Mission Control derived them: never repriced. */
function counters(row: MissionControlUsageRow | MissionControlUnassignedRow) {
  const breakdown = row.modelBreakdown && Object.keys(row.modelBreakdown).length > 0 ? row.modelBreakdown : null;
  const models = modelsFromBreakdown(breakdown);
  return {
    tokensInput: Number(row.tokensInput ?? 0),
    tokensOutput: Number(row.tokensOutput ?? 0),
    tokensCacheRead: Number(row.tokensCacheRead ?? 0),
    tokensCacheCreation: Number(row.tokensCacheCreation ?? 0),
    tokensTotal: Number(row.tokensTotal ?? 0),
    costUsd: row.costUsd == null ? null : Number(row.costUsd),
    ...(breakdown ? { modelBreakdown: breakdown } : {}),
    ...(models.length > 0 ? { models } : {}),
    sources: toSources(row.sources),
    harvestVersion: Number(row.harvestVersion ?? 0),
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  };
}

/** `sessionKey` of the row for a slot occupancy, the main checkout, a non-slot worktree, or a reported-only total. */
export function attributedSessionKey(
  sessionId: string,
  bucket:
    | { kind: 'slot'; slotId: number; occupancyKey: string | null }
    | { kind: 'unassigned'; workDir: string | null; branch: string | null }
    | { kind: 'reported' },
): string {
  if (bucket.kind === 'reported') return `${sessionId}@reported`;
  if (bucket.kind === 'slot') return `${sessionId}@${bucket.slotId}:${bucket.occupancyKey ?? ''}`;
  const worktree = bucket.branch ?? bucket.workDir;
  return worktree ? `${sessionId}@wt:${worktree}` : `${sessionId}@main`;
}

interface Candidate {
  row: PortalUsageRow;
  /** `agentTool\0providerSessionId`; null for a legacy row, which stands alone. */
  session: string | null;
  changedAt: string;
}

function slotRow(row: MissionControlUsageRow, userEmail: string | undefined): PortalUsageRow {
  const sessionId = row.sessionKey;
  return {
    sessionKey: attributedSessionKey(sessionId, {
      kind: 'slot',
      slotId: row.agentId,
      occupancyKey: row.occupancyKey ?? null,
    }),
    providerSessionId: sessionId,
    agentId: row.agentId,
    agentTool: row.agentTool as AgentTool,
    ...(userEmail ? { userEmail } : {}),
    workDir: row.workDir ?? null,
    branch: row.branch ?? null,
    ...(row.suffix ? { suffix: row.suffix } : {}),
    ...(row.occupancyKey ? { occupancyKey: row.occupancyKey } : {}),
    workUnitId: row.workUnitId ?? null,
    attemptId: row.attemptId ?? null,
    ...counters(row),
  };
}

function legacyRow(row: MissionControlUsageRow, userEmail: string | undefined): PortalUsageRow {
  return {
    sessionKey: row.sessionKey,
    agentId: row.agentId,
    agentTool: row.agentTool as AgentTool,
    ...(userEmail ? { userEmail } : {}),
    ...(row.workDir ? { workDir: row.workDir } : {}),
    ...(row.branch ? { branch: row.branch } : {}),
    ...(row.suffix ? { suffix: row.suffix } : {}),
    ...(row.occupancyKey ? { occupancyKey: row.occupancyKey } : {}),
    ...(row.workUnitId ? { workUnitId: row.workUnitId } : {}),
    ...(row.attemptId ? { attemptId: row.attemptId } : {}),
    ...counters(row),
  };
}

function unassignedRow(row: MissionControlUnassignedRow, userEmail: string | undefined): PortalUsageRow {
  const reportedOnly = row.itemized === false;
  const workDir = reportedOnly ? null : (row.workDir ?? null);
  const branch = reportedOnly ? null : (row.branch ?? null);
  return {
    sessionKey: attributedSessionKey(
      row.sessionId,
      reportedOnly ? { kind: 'reported' } : { kind: 'unassigned', workDir, branch },
    ),
    providerSessionId: row.sessionId,
    agentId: MAIN_CHECKOUT_AGENT_ID,
    agentTool: row.agentTool as AgentTool,
    ...(userEmail ? { userEmail } : {}),
    workDir,
    branch,
    workUnitId: null,
    attemptId: null,
    ...counters(row),
  };
}

function candidates(view: MissionControlUsageView, userEmail: string | undefined): Candidate[] {
  const out: Candidate[] = [];
  for (const row of view.usage ?? []) {
    const changedAt = row.changedAt ?? row.updatedAt ?? row.lastSeenAt;
    if (row.origin === 'legacy') {
      out.push({ row: legacyRow(row, userEmail), session: null, changedAt });
    } else {
      out.push({ row: slotRow(row, userEmail), session: `${row.agentTool}\0${row.sessionKey}`, changedAt });
    }
  }
  for (const row of view.unassigned ?? []) {
    out.push({
      row: unassignedRow(row, userEmail),
      session: `${row.agentTool}\0${row.sessionId}`,
      changedAt: row.changedAt ?? row.lastSeenAt,
    });
  }
  return out;
}

export interface AttributedUsageSelection {
  /** The rows to send, one array per provider session (a legacy row is its own group). */
  sessions: PortalUsageRow[][];
  /** Latest `changedAt` among the selected rows: where the watermark may advance to. */
  maxSyncedAt: string | null;
}

/**
 * The rows a sync sends. The portal replaces a provider session's rows with
 * what a sync carries, so a session goes whole or not at all: every current
 * row of each session whose facts changed after `since` (Mission Control's
 * `changedAt` — a new or late observation, or a binding that moved its usage
 * between the main checkout and a slot). `since` null (first sync, `--full`)
 * sends everything.
 */
export function selectAttributedUsage(
  view: MissionControlUsageView,
  since: string | null,
  userEmail?: string,
): AttributedUsageSelection {
  const all = candidates(view, userEmail);
  const changed = (candidate: Candidate) => !since || candidate.changedAt > since;
  const changedSessions = new Set(all.filter(changed).map((c) => c.session).filter((s): s is string => s !== null));

  const groups = new Map<string, PortalUsageRow[]>();
  const sessions: PortalUsageRow[][] = [];
  let maxSyncedAt: string | null = null;
  for (const candidate of all) {
    const selected = candidate.session ? changedSessions.has(candidate.session) : changed(candidate);
    if (!selected) continue;
    if (maxSyncedAt === null || candidate.changedAt > maxSyncedAt) maxSyncedAt = candidate.changedAt;
    if (!candidate.session) {
      sessions.push([candidate.row]);
      continue;
    }
    let group = groups.get(candidate.session);
    if (!group) {
      group = [];
      groups.set(candidate.session, group);
      sessions.push(group);
    }
    group.push(candidate.row);
  }
  return { sessions, maxSyncedAt };
}
