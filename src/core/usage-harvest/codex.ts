import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { USAGE_HARVEST_VERSION } from '../../harness/schema';
import type { AgentSessionUsage } from '../../harness/schema';
import { buildSessionKey } from '../telemetry-env';
import type { HarvestSlotContext } from './claude';
import { workspaceMatchesTarget } from '../workspace-path-match';
import { recordTimeRange, type RecordTimeRange } from './record-time-range';

function codexSessionsRoot(): string {
  return process.env.HAR_CODEX_SESSIONS_DIR
    ? path.resolve(process.env.HAR_CODEX_SESSIONS_DIR)
    : path.join(os.homedir(), '.codex', 'sessions');
}

function walkJsonlFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkJsonlFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

function readJsonl(filePath: string): unknown[] {
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  const out: unknown[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // skip
    }
  }
  return out;
}

function extractCodexTokens(records: unknown[]): {
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  cwd?: string;
  seen: RecordTimeRange | null;
} {
  let tokensInput = 0;
  let tokensOutput = 0;
  let tokensCacheRead = 0;
  let cwd: string | undefined;

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const payload = record as Record<string, unknown>;
    if (typeof payload.cwd === 'string') cwd = payload.cwd;
    if (typeof (payload as { working_directory?: string }).working_directory === 'string') {
      cwd = (payload as { working_directory: string }).working_directory;
    }

    const usage =
      (payload.usage as Record<string, unknown> | undefined) ??
      (payload.token_usage as Record<string, unknown> | undefined) ??
      ((payload.event as { usage?: Record<string, unknown> } | undefined)?.usage);

    if (usage) {
      tokensInput += Number(
        usage.input_tokens ?? usage.input_token_count ?? usage.input ?? 0,
      );
      tokensOutput += Number(
        usage.output_tokens ?? usage.output_token_count ?? usage.output ?? 0,
      );
      tokensCacheRead += Number(
        usage.cached_input_tokens ??
          usage.cached_token_count ??
          usage.cache_read_input_tokens ??
          0,
      );
      tokensOutput += Number(usage.reasoning_tokens ?? usage.reasoning_token_count ?? 0);
    }

    // Cumulative turn totals sometimes appear as top-level fields on response.completed style events.
    if (payload.type === 'response.completed' || payload['event.kind'] === 'response.completed') {
      tokensInput = Math.max(tokensInput, Number(payload.input_token_count ?? 0));
      tokensOutput = Math.max(tokensOutput, Number(payload.output_token_count ?? 0));
      tokensCacheRead = Math.max(tokensCacheRead, Number(payload.cached_token_count ?? 0));
    }
  }

  return { tokensInput, tokensOutput, tokensCacheRead, cwd, seen: recordTimeRange(records) };
}

export function harvestCodexUsage(slot: HarvestSlotContext): AgentSessionUsage | null {
  const primaryTargets = [slot.workDir, slot.worktreePath].filter(Boolean) as string[];
  const fallbackTargets =
    slot.includeRepoPathFallback && slot.repoPath && !primaryTargets.includes(slot.repoPath)
      ? [slot.repoPath]
      : [];
  if (primaryTargets.length === 0 && fallbackTargets.length === 0) return null;

  const root = codexSessionsRoot();
  const files = walkJsonlFiles(root);
  if (files.length === 0) return null;

  const sessionKey = buildSessionKey({
    branch: slot.branch,
    agentId: slot.agentId,
    suffix: slot.suffix,
    createdAt: slot.sessionCreatedAt,
  });

  type CodexTokens = {
    tokensInput: number;
    tokensOutput: number;
    tokensCacheRead: number;
    seen: RecordTimeRange | null;
  };
  let bestPrimary: CodexTokens | null = null;
  let bestPrimaryMtime = 0;
  let bestFallback: CodexTokens | null = null;
  let bestFallbackMtime = 0;

  for (const file of files) {
    const records = readJsonl(file);
    const extracted = extractCodexTokens(records);
    if (!extracted.cwd) continue;
    if (extracted.tokensInput + extracted.tokensOutput + extracted.tokensCacheRead === 0) continue;
    const mtime = fs.statSync(file).mtimeMs;
    if (workspaceMatchesTarget(extracted.cwd, primaryTargets)) {
      if (mtime >= bestPrimaryMtime) {
        bestPrimaryMtime = mtime;
        bestPrimary = extracted;
      }
    } else if (workspaceMatchesTarget(extracted.cwd, fallbackTargets)) {
      if (mtime >= bestFallbackMtime) {
        bestFallbackMtime = mtime;
        bestFallback = extracted;
      }
    }
  }

  const best = bestPrimary ?? bestFallback;
  if (!best) return null;
  const now = new Date().toISOString();
  const tokensTotal = best.tokensInput + best.tokensOutput + best.tokensCacheRead;

  return {
    sessionKey,
    agentId: slot.agentId,
    agentTool: 'codex',
    workDir: slot.workDir,
    branch: slot.branch,
    suffix: slot.suffix,
    tokensInput: best.tokensInput,
    tokensOutput: best.tokensOutput,
    tokensCacheRead: best.tokensCacheRead,
    tokensCacheCreation: 0,
    tokensTotal,
    costUsd: null,
    sources: ['harvest'],
    harvestVersion: USAGE_HARVEST_VERSION,
    firstSeenAt: best.seen?.firstAt ?? slot.sessionCreatedAt ?? now,
    lastSeenAt: best.seen?.lastAt ?? now,
  };
}
