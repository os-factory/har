import { calcPrice } from '@pydantic/genai-prices';

/**
 * Model pricing from the bundled genai-prices catalog. Free of zod and of the
 * HAR domain schema, so it ships in the `@osfactory/har/attribution` library
 * entry that har-portal runs alongside Mission Control.
 */

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

function providerHint(agentTool: string): string | undefined {
  if (agentTool === 'claude_code') return 'anthropic';
  if (agentTool === 'codex') return 'openai';
  if (agentTool === 'cursor') return 'cursor';
  return undefined;
}

/**
 * Map HAR token buckets to genai-prices semantics.
 * genai-prices treats `input_tokens` as the inclusive parent; cache read/write are subsets.
 * Every modelBreakdown producer reports disjoint buckets (uncached input vs cache).
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
  return {
    input_tokens: rawInput + cacheRead + cacheWrite,
    output_tokens: num(totals.tokensOutput),
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
  };
}

/** Cursor prefixes opaque slugs — try stripped and tier aliases against the catalog too. */
export function pricingModelCandidates(modelId: string): string[] {
  const out = [modelId];
  let normalized = modelId;
  if (normalized.startsWith('cursor-')) {
    normalized = normalized.slice('cursor-'.length);
    out.push(normalized);
  }
  if (normalized.endsWith('-high-fast')) {
    out.push(normalized.replace(/-high-fast$/, '-fast'));
  } else if (normalized.endsWith('-high')) {
    out.push(normalized.replace(/-high$/, ''));
  }
  return [...new Set(out)];
}

/** Estimate USD for one model row using bundled genai-prices catalog data. */
export function estimateModelCostUsd(
  modelId: string,
  totals: ModelUsageTotals,
  agentTool: string,
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
