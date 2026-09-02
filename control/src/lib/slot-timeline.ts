/**
 * One chronological timeline for "what happened" in a slot occupancy or a work unit.
 *
 * Replaces the separate Runs / Snapshots / Evidence tables and the slot "Session
 * activity" and "Usage by agent" cards (#338). Rows are heterogeneous but share a
 * flat shape so a single DataTable can render, search and expand them.
 */

export type TimelineKind = 'occupancy' | 'session' | 'run' | 'snapshot' | 'commit';

export type TimelineTone = 'pass' | 'fail' | 'warn' | 'neutral';

export interface TimelineStageChip {
  name: string;
  pass: boolean;
  ms: number | null;
}

export interface TimelineChangedFile {
  status: string;
  path: string;
}

export interface TimelineSessionDetail {
  sessionKey: string;
  agentTool: string;
  models: string[];
  durationMs: number | null;
  tokensTotal: number;
  costUsd: number | null;
  firstPrompt: string | null;
  sources: string[];
}

export interface TimelineRunDetail {
  runId: string;
  stageId: string;
  kind: string | null;
  status: string;
  trigger: string;
  durationMs: number | null;
  stages: TimelineStageChip[];
}

export interface TimelineSnapshotDetail {
  validationId: string;
  treeHash: string;
  branch: string | null;
  status: string;
  full: boolean;
  runId: string | null;
  changedFiles: TimelineChangedFile[];
  commitSha: string | null;
}

export interface TimelineCommitDetail {
  sha: string;
  message: string | null;
  treeHash: string;
  branch: string | null;
  refs: string[];
}

export interface TimelineOccupancyDetail {
  branch: string | null;
  baseCommit: string | null;
  worktreePath: string | null;
  attemptId: string | null;
}

export interface TimelineRow {
  id: string;
  kind: TimelineKind;
  /** ISO timestamp; rows are sorted newest first. */
  at: string;
  title: string;
  detail: string | null;
  status: string | null;
  tone: TimelineTone;
  agentId: number | null;
  session?: TimelineSessionDetail;
  run?: TimelineRunDetail;
  snapshot?: TimelineSnapshotDetail;
  commit?: TimelineCommitDetail;
  occupancy?: TimelineOccupancyDetail;
}

export interface TimelineRunInput {
  runId: string;
  stageId: string;
  kind: string | null;
  status: string;
  trigger: string;
  durationMs: number | null;
  agentId: number | null;
  startedAt: Date;
  stages: TimelineStageChip[];
}

export interface TimelineSnapshotInput {
  validationId: string;
  treeHash: string;
  branch: string | null;
  agentId: number | null;
  status: string;
  full: boolean;
  runId: string | null;
  changedFiles: TimelineChangedFile[];
  commitSha: string | null;
  committedAt: Date | null;
  createdAt: Date;
}

export interface TimelineCommitInput {
  commitSha: string;
  treeHash: string;
  message: string | null;
  refs: string[];
  branch: string | null;
  agentId: number | null;
  at: Date;
}

export interface TimelineSessionInput {
  sessionKey: string;
  agentTool: string;
  agentId: number | null;
  models: string[];
  tokensTotal: number;
  costUsd: number | null;
  sources: string[];
  firstSeenAt: Date;
  lastSeenAt: Date;
  firstPrompt: string | null;
}

export interface TimelineOccupancyInput {
  id: string;
  agentId: number | null;
  title: string;
  at: Date;
  branch: string | null;
  baseCommit: string | null;
  worktreePath: string | null;
  attemptId: string | null;
}

export interface TimelineInput {
  occupancies?: TimelineOccupancyInput[];
  sessions?: TimelineSessionInput[];
  runs?: TimelineRunInput[];
  snapshots?: TimelineSnapshotInput[];
  commits?: TimelineCommitInput[];
}

export const TIMELINE_KIND_LABEL: Record<TimelineKind, string> = {
  occupancy: 'Session',
  session: 'Agent',
  run: 'Run',
  snapshot: 'Snapshot',
  commit: 'Commit',
};

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function runTone(status: string): TimelineTone {
  if (status === 'pass') return 'pass';
  if (status === 'fail' || status === 'error') return 'fail';
  if (status.includes('warning') || status === 'bypass') return 'warn';
  return 'neutral';
}

function runStatusLabel(status: string): string {
  if (status === 'pass') return 'Passed';
  if (status === 'fail') return 'Failed';
  if (status === 'error') return 'Error';
  if (status === 'bypass_warning') return 'Bypassed';
  return status.replace(/_/g, ' ');
}

function snapshotStatus(input: Pick<TimelineSnapshotInput, 'status' | 'full'>): { label: string; tone: TimelineTone } {
  if (input.status === 'pass' && input.full) return { label: 'Verified', tone: 'pass' };
  if (input.status === 'pass') return { label: 'Partial verify', tone: 'warn' };
  return { label: 'Failed', tone: 'fail' };
}

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/**
 * Merge every event source into one newest-first list. Commits recorded on a
 * snapshot (`commitSha`) are emitted as their own rows unless a commit binding
 * with the same sha already exists.
 */
export function buildTimelineRows(input: TimelineInput): TimelineRow[] {
  const rows: TimelineRow[] = [];

  for (const occupancy of input.occupancies ?? []) {
    rows.push({
      id: `occupancy:${occupancy.id}`,
      kind: 'occupancy',
      at: occupancy.at.toISOString(),
      title: occupancy.title,
      detail: [occupancy.branch, occupancy.baseCommit ? `from ${shortSha(occupancy.baseCommit)}` : null]
        .filter(Boolean)
        .join(' · ') || null,
      status: null,
      tone: 'neutral',
      agentId: occupancy.agentId,
      occupancy: {
        branch: occupancy.branch,
        baseCommit: occupancy.baseCommit,
        worktreePath: occupancy.worktreePath,
        attemptId: occupancy.attemptId,
      },
    });
  }

  for (const session of input.sessions ?? []) {
    const durationMs = Math.max(0, session.lastSeenAt.getTime() - session.firstSeenAt.getTime());
    const cost = session.costUsd;
    rows.push({
      id: `session:${session.sessionKey}:${session.agentTool}`,
      kind: 'session',
      at: session.firstSeenAt.toISOString(),
      title: session.firstPrompt ? truncate(session.firstPrompt, 140) : `${session.agentTool} session`,
      detail: [
        session.models[0] ?? null,
        session.tokensTotal > 0 ? `${formatTokenCount(session.tokensTotal)} tokens` : null,
        cost != null ? `$${cost.toFixed(2)}` : null,
      ]
        .filter(Boolean)
        .join(' · ') || 'usage not harvested yet',
      status: session.agentTool,
      tone: 'neutral',
      agentId: session.agentId,
      session: {
        sessionKey: session.sessionKey,
        agentTool: session.agentTool,
        models: session.models,
        durationMs: durationMs > 0 ? durationMs : null,
        tokensTotal: session.tokensTotal,
        costUsd: cost,
        firstPrompt: session.firstPrompt,
        sources: session.sources,
      },
    });
  }

  for (const run of input.runs ?? []) {
    const failed = run.stages.filter((stage) => !stage.pass).map((stage) => stage.name);
    rows.push({
      id: `run:${run.runId}`,
      kind: 'run',
      at: run.startedAt.toISOString(),
      title: run.kind === 'verify' || run.stageId === 'verify' ? 'Verify' : run.stageId,
      detail: failed.length > 0
        ? `failed: ${failed.join(', ')}`
        : run.stages.length > 0
          ? `${run.stages.length} stages`
          : run.trigger,
      status: runStatusLabel(run.status),
      tone: runTone(run.status),
      agentId: run.agentId,
      run: {
        runId: run.runId,
        stageId: run.stageId,
        kind: run.kind,
        status: run.status,
        trigger: run.trigger,
        durationMs: run.durationMs,
        stages: run.stages,
      },
    });
  }

  const commitShas = new Set((input.commits ?? []).map((commit) => commit.commitSha));

  for (const snapshot of input.snapshots ?? []) {
    const status = snapshotStatus(snapshot);
    rows.push({
      id: `snapshot:${snapshot.treeHash}`,
      kind: 'snapshot',
      at: snapshot.createdAt.toISOString(),
      title: `Tree ${snapshot.treeHash.slice(0, 8)}`,
      detail: `${snapshot.changedFiles.length} changed file${snapshot.changedFiles.length === 1 ? '' : 's'}`,
      status: status.label,
      tone: status.tone,
      agentId: snapshot.agentId,
      snapshot: {
        validationId: snapshot.validationId,
        treeHash: snapshot.treeHash,
        branch: snapshot.branch,
        status: snapshot.status,
        full: snapshot.full,
        runId: snapshot.runId,
        changedFiles: snapshot.changedFiles,
        commitSha: snapshot.commitSha,
      },
    });
    if (snapshot.commitSha && !commitShas.has(snapshot.commitSha)) {
      commitShas.add(snapshot.commitSha);
      rows.push({
        id: `commit:${snapshot.commitSha}`,
        kind: 'commit',
        at: (snapshot.committedAt ?? snapshot.createdAt).toISOString(),
        title: `Commit ${shortSha(snapshot.commitSha)}`,
        detail: snapshot.branch,
        status: status.label === 'Verified' ? 'Verified tree' : null,
        tone: status.label === 'Verified' ? 'pass' : 'neutral',
        agentId: snapshot.agentId,
        commit: {
          sha: snapshot.commitSha,
          message: null,
          treeHash: snapshot.treeHash,
          branch: snapshot.branch,
          refs: [],
        },
      });
    }
  }

  for (const commit of input.commits ?? []) {
    rows.push({
      id: `commit:${commit.commitSha}`,
      kind: 'commit',
      at: commit.at.toISOString(),
      title: commit.message ? truncate(commit.message.split('\n')[0] ?? '', 120) : `Commit ${shortSha(commit.commitSha)}`,
      detail: [shortSha(commit.commitSha), commit.branch].filter(Boolean).join(' · '),
      status: 'Verified tree',
      tone: 'pass',
      agentId: commit.agentId,
      commit: {
        sha: commit.commitSha,
        message: commit.message,
        treeHash: commit.treeHash,
        branch: commit.branch,
        refs: commit.refs,
      },
    });
  }

  return rows.sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}

export interface TimelineTotals {
  sessions: number;
  runs: number;
  verifyPassed: number;
  snapshots: number;
  commits: number;
  tokensTotal: number;
  costUsd: number | null;
}

export function summarizeTimeline(rows: TimelineRow[]): TimelineTotals {
  const totals: TimelineTotals = {
    sessions: 0,
    runs: 0,
    verifyPassed: 0,
    snapshots: 0,
    commits: 0,
    tokensTotal: 0,
    costUsd: null,
  };
  for (const row of rows) {
    if (row.kind === 'session' && row.session) {
      totals.sessions += 1;
      totals.tokensTotal += row.session.tokensTotal;
      if (row.session.costUsd != null) totals.costUsd = (totals.costUsd ?? 0) + row.session.costUsd;
    } else if (row.kind === 'run' && row.run) {
      totals.runs += 1;
      if (row.run.status === 'pass') totals.verifyPassed += 1;
    } else if (row.kind === 'snapshot') {
      totals.snapshots += 1;
    } else if (row.kind === 'commit') {
      totals.commits += 1;
    }
  }
  return totals;
}

/** Plain-language summary line shown above the table. */
export function describeTimeline(totals: TimelineTotals): string {
  const parts: string[] = [];
  parts.push(`${totals.sessions} agent session${totals.sessions === 1 ? '' : 's'}`);
  parts.push(`${totals.runs} run${totals.runs === 1 ? '' : 's'}${totals.runs > 0 ? ` (${totals.verifyPassed} passed)` : ''}`);
  parts.push(`${totals.snapshots} snapshot${totals.snapshots === 1 ? '' : 's'}`);
  parts.push(`${totals.commits} commit${totals.commits === 1 ? '' : 's'}`);
  if (totals.tokensTotal > 0) {
    parts.push(`${formatTokenCount(totals.tokensTotal)} tokens${totals.costUsd != null ? ` · $${totals.costUsd.toFixed(2)}` : ''}`);
  }
  return parts.join(' · ');
}
