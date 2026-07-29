import { calcPrice } from '@pydantic/genai-prices';
import type { AgentSessionUsage, AgentTool } from './schema';

/** Per-model token and cost fields stored on AgentSessionUsage.modelBreakdown. */
export interface ModelUsageTotals {
  tokensInput?: number;
  tokensOutput?: number;
  tokensCacheRead?: number;
  tokensCacheCreation?: number;
  tokensTotal?: number;
  /** USD cost for this model row (reported by the agent or estimated via genai-prices). */
  costUsd?: number;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function resolveCostUsd(reported: number | null, computed: number | null): number | null {
  if (reported == null && computed == null) return null;
  if (reported == null) return computed;
  if (computed == null) return reported;
  return Math.max(reported, computed);
}

function providerHint(agentTool: AgentTool): string | undefined {
  if (agentTool === 'claude_code') return 'anthropic';
  if (agentTool === 'codex') return 'openai';
  return undefined;
}

/**
 * Map HAR token buckets to genai-prices semantics.
 * genai-prices treats `input_tokens` as the inclusive parent; cache read/write are subsets.
 * Claude harvest reports disjoint buckets (uncached input vs cache creation).
 */
export function toGenaiPricesUsage(totals: ModelUsageTotals): {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
} {
  const rawInput = num(totals.tokensInput);
  const cacheRead = num(totals.tokensCacheRead);
  const cacheWrite = num(totals.tokensCacheCreation);
  const uncached = rawInput >= cacheRead ? rawInput - cacheRead : rawInput;
  const inclusiveInput = uncached + cacheRead + cacheWrite;
  return {
    input_tokens: inclusiveInput,
    output_tokens: num(totals.tokensOutput),
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
  };
}

/** Cursor prefixes opaque slugs — try the stripped id against the catalog too. */
export function pricingModelCandidates(modelId: string): string[] {
  const out = [modelId];
  if (modelId.startsWith('cursor-')) out.push(modelId.slice('cursor-'.length));
  return [...new Set(out)];
}

/** Estimate USD for one model row using bundled genai-prices catalog data. */
export function estimateModelCostUsd(
  modelId: string,
  totals: ModelUsageTotals,
  agentTool: AgentTool,
): number | null {
  const usage = toGenaiPricesUsage(totals);
  const tokenSum = usage.input_tokens + usage.output_tokens;
  if (tokenSum <= 0) return null;

  const providerId = providerHint(agentTool);
  for (const candidate of pricingModelCandidates(modelId)) {
    try {
      const result = calcPrice(usage, candidate, providerId ? { providerId } : undefined);
      if (result) return result.total_price;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Attach per-model and session-level USD costs from genai-prices when modelBreakdown
 * has token data. Preserves agent-reported costUsd when present (max with estimate).
 */
export function enrichUsageWithPricing<
  T extends Pick<AgentSessionUsage, 'agentTool' | 'costUsd' | 'modelBreakdown'>,
>(usage: T): T {
  const breakdown = usage.modelBreakdown;
  if (!breakdown || typeof breakdown !== 'object' || Array.isArray(breakdown)) {
    return usage;
  }

  let computedTotal = 0;
  let hasComputed = false;
  const enriched: Record<string, ModelUsageTotals> = {};

  for (const [modelId, raw] of Object.entries(breakdown as Record<string, unknown>)) {
    if (!modelId) continue;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      continue;
    }
    const totals = raw as ModelUsageTotals;
    const existingCost = totals.costUsd == null ? null : num(totals.costUsd);
    const estimated =
      existingCost ?? estimateModelCostUsd(modelId, totals, usage.agentTool);
    if (estimated != null) {
      computedTotal += estimated;
      hasComputed = true;
      enriched[modelId] = { ...totals, costUsd: estimated };
    } else {
      enriched[modelId] = totals;
    }
  }

  if (!hasComputed) return usage;

  const reported = usage.costUsd == null ? null : num(usage.costUsd);
  const costUsd = resolveCostUsd(reported, computedTotal);

  return {
    ...usage,
    modelBreakdown: enriched,
    ...(costUsd != null ? { costUsd } : {}),
  };
}
