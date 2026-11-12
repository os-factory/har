import * as fs from 'fs';
import * as path from 'path';
import { USAGE_HARVEST_VERSION } from '../../harness/schema';
import type { AgentSessionUsage } from '../../harness/schema';
import { workspaceMatchesTarget } from '../workspace-path-match';
import {
  claudeProjectsRoot,
  extractClaudeUsageFromRecords,
  readJsonlRecords,
} from './claude';
import { recordTimeRange } from './record-time-range';

/**
 * Claude token usage, harvested by the session Mission Control already
 * attributed to a slot.
 *
 * Claude Code puts no token counters on any hook callback (otel-hook
 * docs/claude-code-usage-contract.md, finding 1), so Claude cost reaches
 * Mission Control only through harvest. The per-slot harvest finds transcripts
 * by the slot's work dir — but HAR's normal flow is an agent started in the main
 * checkout that launches a slot and edits the worktree by path. Its transcript
 * is filed under the main checkout (`cwd` = main checkout) and never matches.
 *
 * Mission Control does link that session to the slot (its spans carry
 * `session.id` and the resolved `agentId`), and `session.id` is the transcript's
 * file name. This harvest follows that link: one usage row per Claude session,
 * keyed by the same `sessionKey` as its spans.
 */

/** One Claude session as Mission Control attributed it. */
export interface AttributedClaudeSession {
  sessionId: string;
  sessionKey: string;
  agentId: number;
  workDir?: string;
  branch?: string;
  suffix?: string;
  workUnitId?: string;
  attemptId?: string;
}

/** Claude Code session ids are UUIDs; anything else is never joined into a path. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/;

/** `~/.claude/projects/<any project>/<sessionId>.jsonl`, or null. */
export function findClaudeTranscriptBySessionId(sessionId: string): string | null {
  if (!SESSION_ID_PATTERN.test(sessionId)) return null;
  const root = claudeProjectsRoot();
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function recordCwds(records: unknown[]): string[] {
  const cwds = new Set<string>();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const cwd = (record as { cwd?: unknown }).cwd;
    if (typeof cwd === 'string' && cwd) cwds.add(cwd);
  }
  return [...cwds];
}

/**
 * Usage rows for sessions Mission Control attributed to a slot.
 *
 * `slotWorkspaces` are the work dirs the per-slot harvest already reads: a
 * transcript whose `cwd` falls under one of them is skipped so the same tokens
 * are never posted under two session keys.
 */
export function harvestClaudeUsageForSessions(
  sessions: AttributedClaudeSession[],
  slotWorkspaces: string[],
): AgentSessionUsage[] {
  const rows: AgentSessionUsage[] = [];
  const seen = new Set<string>();
  const now = new Date().toISOString();

  for (const session of sessions) {
    if (seen.has(session.sessionId)) continue;
    seen.add(session.sessionId);

    const filePath = findClaudeTranscriptBySessionId(session.sessionId);
    if (!filePath) continue;
    const records = readJsonlRecords(filePath);
    if (
      slotWorkspaces.length > 0 &&
      recordCwds(records).some((cwd) => workspaceMatchesTarget(cwd, slotWorkspaces))
    ) {
      continue;
    }

    const usage = extractClaudeUsageFromRecords(records);
    if (
      usage.tokensInput + usage.tokensOutput + usage.tokensCacheRead === 0 &&
      (usage.costUsd == null || usage.costUsd === 0)
    ) {
      continue;
    }

    const seenRange = recordTimeRange(records);
    rows.push({
      sessionKey: session.sessionKey,
      agentId: session.agentId,
      agentTool: 'claude_code',
      workDir: session.workDir,
      branch: session.branch,
      suffix: session.suffix,
      workUnitId: session.workUnitId,
      attemptId: session.attemptId,
      tokensInput: usage.tokensInput,
      tokensOutput: usage.tokensOutput,
      tokensCacheRead: usage.tokensCacheRead,
      tokensCacheCreation: usage.tokensCacheCreation,
      tokensTotal:
        usage.tokensInput + usage.tokensOutput + usage.tokensCacheRead + usage.tokensCacheCreation,
      costUsd: usage.costUsd,
      ...(Object.keys(usage.modelBreakdown).length > 0
        ? { modelBreakdown: usage.modelBreakdown }
        : {}),
      sources: ['harvest'],
      harvestVersion: USAGE_HARVEST_VERSION,
      firstSeenAt: seenRange?.firstAt ?? now,
      lastSeenAt: seenRange?.lastAt ?? now,
    });
  }
  return rows;
}
