import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { AgentSessionUsage } from '../../harness/schema';
import { buildSessionKey } from '../telemetry-env';

export interface HarvestSlotContext {
  agentId: number;
  workDir?: string;
  worktreePath?: string;
  branch?: string;
  suffix?: string;
  sessionCreatedAt?: string;
  repoPath: string;
}

function pathsMatch(candidate: string, targets: string[]): boolean {
  const norm = path.resolve(candidate);
  return targets.some((t) => {
    const target = path.resolve(t);
    return norm === target || norm.startsWith(target + path.sep) || target.startsWith(norm + path.sep);
  });
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

function extractClaudeUsageFromRecords(records: unknown[]): {
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  costUsd: number | null;
} {
  let tokensInput = 0;
  let tokensOutput = 0;
  let tokensCacheRead = 0;
  let tokensCacheCreation = 0;
  let costUsd: number | null = null;

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
    const nestedUsage = (payload.usage ??
      (payload.message as { usage?: Record<string, unknown> } | undefined)?.usage) as
      | Record<string, unknown>
      | undefined;
    if (nestedUsage && payload.type !== 'result') {
      tokensInput += Number(nestedUsage.input_tokens ?? 0);
      tokensOutput += Number(nestedUsage.output_tokens ?? 0);
      tokensCacheRead += Number(nestedUsage.cache_read_input_tokens ?? 0);
      tokensCacheCreation += Number(nestedUsage.cache_creation_input_tokens ?? 0);
    }
  }

  return { tokensInput, tokensOutput, tokensCacheRead, tokensCacheCreation, costUsd };
}

export function harvestClaudeUsage(slot: HarvestSlotContext): AgentSessionUsage | null {
  const targets = [slot.workDir, slot.worktreePath].filter(Boolean) as string[];
  if (targets.length === 0) return null;

  const root = claudeProjectsRoot();
  if (!fs.existsSync(root)) return null;

  const sessionKey = buildSessionKey({
    branch: slot.branch,
    agentId: slot.agentId,
    suffix: slot.suffix,
    createdAt: slot.sessionCreatedAt,
  });

  let best: ReturnType<typeof extractClaudeUsageFromRecords> | null = null;
  let bestMtime = 0;

  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const projectDir = path.join(root, entry.name);
    // Prefer directories that encode one of our cwds; also scan for cwd in session files.
    const encodedHit = targets.some((t) => entry.name.includes(encodeClaudeProjectDir(t).slice(0, 40)));

    for (const file of fs.readdirSync(projectDir)) {
      if (!file.endsWith('.jsonl')) continue;
      const filePath = path.join(projectDir, file);
      const stat = fs.statSync(filePath);
      const records = readJsonlRecords(filePath);
      let cwdHit = encodedHit;
      for (const record of records) {
        if (!record || typeof record !== 'object') continue;
        const cwd = String((record as { cwd?: string }).cwd ?? '');
        if (cwd && pathsMatch(cwd, targets)) {
          cwdHit = true;
          break;
        }
      }
      if (!cwdHit) continue;
      const usage = extractClaudeUsageFromRecords(records);
      if (
        usage.tokensInput + usage.tokensOutput + usage.tokensCacheRead === 0 &&
        (usage.costUsd == null || usage.costUsd === 0)
      ) {
        continue;
      }
      if (stat.mtimeMs >= bestMtime) {
        bestMtime = stat.mtimeMs;
        best = usage;
      }
    }
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
    sources: ['harvest'],
    firstSeenAt: slot.sessionCreatedAt ?? now,
    lastSeenAt: now,
  };
}
