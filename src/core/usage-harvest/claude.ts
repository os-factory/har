import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSessionEvent, AgentSessionUsage } from '../../harness/schema';
import { getTelemetrySignals } from '../telemetry-config';
import { buildSessionKey } from '../telemetry-env';
import { workspaceMatchesTarget } from '../workspace-path-match';

export interface HarvestSlotContext {
  agentId: number;
  workDir?: string;
  worktreePath?: string;
  branch?: string;
  suffix?: string;
  sessionCreatedAt?: string;
  repoPath: string;
}

function claudeProjectsRoot(): string {
  return process.env.HAR_CLAUDE_PROJECTS_DIR
    ? path.resolve(process.env.HAR_CLAUDE_PROJECTS_DIR)
    : path.join(os.homedir(), '.claude', 'projects');
}

/** Encode a cwd the way Claude Code names project folders. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function readJsonlRecords(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const out: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip bad lines
    }
  }
  return out;
}

export interface ModelUsageTotals {
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  tokensTotal: number;
}

function extractClaudeUsageFromRecords(records: unknown[]): {
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  costUsd: number | null;
  modelBreakdown: Record<string, ModelUsageTotals>;
} {
  let tokensInput = 0;
  let tokensOutput = 0;
  let tokensCacheRead = 0;
  let tokensCacheCreation = 0;
  let costUsd: number | null = null;
  const modelBreakdown: Record<string, ModelUsageTotals> = {};

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const payload = record as Record<string, unknown>;
    if (payload.type === 'result') {
      const usage = (payload.usage ?? {}) as Record<string, unknown>;
      tokensInput =
        Number(usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens ?? 0);
      tokensOutput = Number(usage.output_tokens ?? 0);
      tokensCacheRead = Number(usage.cache_read_input_tokens ?? 0);
      tokensCacheCreation = Number(usage.cache_creation_input_tokens ?? 0);
      if (payload.total_cost_usd != null) costUsd = Number(payload.total_cost_usd);
    }
    // Some transcripts nest usage on message/assistant events — accumulate when present.
    const message = payload.message as
      | { usage?: Record<string, unknown>; model?: string }
      | undefined;
    const nestedUsage = (payload.usage ?? message?.usage) as
      | Record<string, unknown>
      | undefined;
    if (nestedUsage && payload.type !== 'result') {
      const i = Number(nestedUsage.input_tokens ?? 0);
      const o = Number(nestedUsage.output_tokens ?? 0);
      const cr = Number(nestedUsage.cache_read_input_tokens ?? 0);
      const cc = Number(nestedUsage.cache_creation_input_tokens ?? 0);
      tokensInput += i;
      tokensOutput += o;
      tokensCacheRead += cr;
      tokensCacheCreation += cc;
      const model = typeof message?.model === 'string' ? message.model : undefined;
      if (model && model !== '<synthetic>') {
        const totals = (modelBreakdown[model] ??= {
          tokensInput: 0,
          tokensOutput: 0,
          tokensCacheRead: 0,
          tokensCacheCreation: 0,
          tokensTotal: 0,
        });
        totals.tokensInput += i;
        totals.tokensOutput += o;
        totals.tokensCacheRead += cr;
        totals.tokensCacheCreation += cc;
        totals.tokensTotal += i + o + cr + cc;
      }
    }
  }

  return { tokensInput, tokensOutput, tokensCacheRead, tokensCacheCreation, costUsd, modelBreakdown };
}

function findMatchingClaudeTranscripts(slot: HarvestSlotContext): Array<{ filePath: string; records: unknown[]; mtimeMs: number }> {
  const targets = [slot.workDir, slot.worktreePath].filter(Boolean) as string[];
  if (targets.length === 0) return [];

  const root = claudeProjectsRoot();
  if (!fs.existsSync(root)) return [];

  const matches: Array<{ filePath: string; records: unknown[]; mtimeMs: number }> = [];

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(root, entry.name);
    const encodedHit = targets.some((t) => entry.name === encodeClaudeProjectDir(t));

    for (const file of fs.readdirSync(projectDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(projectDir, file);
      const stat = fs.statSync(filePath);
      const records = readJsonlRecords(filePath);
      let cwdHit = encodedHit;
      for (const record of records) {
        if (!record || typeof record !== 'object') continue;
        const cwd = String((record as { cwd?: string }).cwd ?? '');
        if (cwd && workspaceMatchesTarget(cwd, targets)) {
          cwdHit = true;
          break;
        }
      }
      if (!cwdHit) continue;
      matches.push({ filePath, records, mtimeMs: stat.mtimeMs });
    }
  }

  return matches.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function extractPromptEvents(
  records: unknown[],
  sessionKey: string,
  slot: HarvestSlotContext,
): AgentSessionEvent[] {
  const events: AgentSessionEvent[] = [];
  let sequence = 0;
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const payload = record as Record<string, unknown>;
    const typ = String(payload.type ?? '');
    const message = payload.message as
      | { role?: string; content?: unknown }
      | undefined;
    const role = String(message?.role ?? payload.role ?? '');
    let text: string | null = null;
    const content = message?.content ?? payload.content;
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) {
      text = content
        .map((part) => {
          if (typeof part === 'string') return part;
          if (part && typeof part === 'object' && typeof (part as { text?: string }).text === 'string') {
            return (part as { text: string }).text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    if (!text || text.trim().length === 0) continue;

    const isUser =
      typ === 'user' || role === 'user' || typ === 'human' || Boolean(payload.userType);
    const isAssistant = typ === 'assistant' || role === 'assistant';
    if (!isUser && !isAssistant) continue;

    sequence += 1;
    const timestamp =
      typeof payload.timestamp === 'string'
        ? payload.timestamp
        : typeof payload.ts === 'string'
          ? payload.ts
          : new Date().toISOString();

    events.push({
      sessionKey,
      agentId: slot.agentId,
      agentTool: 'claude_code',
      eventName: isUser ? 'claude_code.user_prompt' : 'claude_code.assistant_response',
      sequence,
      timestamp,
      promptText: isUser ? text.slice(0, 8000) : null,
      responseText: isAssistant ? text.slice(0, 8000) : null,
      rawTruncated: text.slice(0, 4000),
      source: 'harvest',
    });
  }
  return events;
}

export function harvestClaudeUsage(slot: HarvestSlotContext): AgentSessionUsage | null {
  const matches = findMatchingClaudeTranscripts(slot);
  const sessionKey = buildSessionKey({
    branch: slot.branch,
    agentId: slot.agentId,
    suffix: slot.suffix,
    createdAt: slot.sessionCreatedAt,
  });

  let best: ReturnType<typeof extractClaudeUsageFromRecords> | null = null;
  for (const match of matches) {
    const usage = extractClaudeUsageFromRecords(match.records);
    if (
      usage.tokensInput + usage.tokensOutput + usage.tokensCacheRead === 0 &&
      (usage.costUsd == null || usage.costUsd === 0)
    ) {
      continue;
    }
    best = usage;
    break;
  }

  if (!best) return null;
  const now = new Date().toISOString();
  const tokensTotal =
    best.tokensInput + best.tokensOutput + best.tokensCacheRead + best.tokensCacheCreation;

  return {
    sessionKey,
    agentId: slot.agentId,
    agentTool: 'claude_code',
    workDir: slot.workDir,
    branch: slot.branch,
    suffix: slot.suffix,
    tokensInput: best.tokensInput,
    tokensOutput: best.tokensOutput,
    tokensCacheRead: best.tokensCacheRead,
    tokensCacheCreation: best.tokensCacheCreation,
    tokensTotal,
    costUsd: best.costUsd,
    ...(Object.keys(best.modelBreakdown).length > 0
      ? { modelBreakdown: best.modelBreakdown }
      : {}),
    sources: ['harvest'],
    firstSeenAt: slot.sessionCreatedAt ?? now,
    lastSeenAt: now,
  };
}

/** Prompt/message summaries from local JSONL — only when prompts signal is on. */
export function harvestClaudeEvents(slot: HarvestSlotContext): AgentSessionEvent[] {
  if (!getTelemetrySignals().prompts) return [];
  const matches = findMatchingClaudeTranscripts(slot);
  if (matches.length === 0) return [];
  const sessionKey = buildSessionKey({
    branch: slot.branch,
    agentId: slot.agentId,
    suffix: slot.suffix,
    createdAt: slot.sessionCreatedAt,
  });
  // Newest transcript only — avoid flooding with historical chats.
  return extractPromptEvents(matches[0].records, sessionKey, slot).slice(-40);
}
