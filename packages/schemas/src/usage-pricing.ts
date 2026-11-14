import type { AgentSessionUsage } from './schema';
import { UNPRICED_AGENT_TOOLS, estimateModelCostUsd, type ModelUsageTotals } from './model-pricing';

export * from './model-pricing';

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function resolveCostUsd(reported: number | null, computed: number | null): number | null {
  if (reported == null && computed == null) return null;
  if (reported == null) return computed;
  if (computed == null) return reported;
  return Math.max(reported, computed);
}

/** A row of an unpriced agent tool: tokens only, no cost on the row or its models. */
function stripCosts<T extends Pick<AgentSessionUsage, 'agentTool' | 'costUsd' | 'modelBreakdown'>>(usage: T): T {
  const breakdown = usage.modelBreakdown;
  const models =
    breakdown && typeof breakdown === 'object' && !Array.isArray(breakdown)
      ? Object.fromEntries(
          Object.entries(breakdown as Record<string, unknown>).map(([model, raw]) => [
            model,
            raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as object), costUsd: null } : raw,
          ]),
        )
      : breakdown;
  return { ...usage, costUsd: null, ...(models ? { modelBreakdown: models } : {}) };
}

/**
 * Attach per-model and session-level USD costs from genai-prices when modelBreakdown
 * has token data. Preserves agent-reported costUsd when present (max with estimate).
 */
export function enrichUsageWithPricing<
  T extends Pick<AgentSessionUsage, 'agentTool' | 'costUsd' | 'modelBreakdown'>,
>(usage: T): T {
  if (UNPRICED_AGENT_TOOLS.has(usage.agentTool)) return stripCosts(usage);
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
    // A stored per-model cost is a floor, not the answer: Mission Control merges
    // a re-synced session's growing token counts into a breakdown that still
    // carries the cost priced at the first sync, and reusing it froze the cost.
    const existingCost = totals.costUsd == null ? null : num(totals.costUsd);
    const fresh = estimateModelCostUsd(modelId, totals, usage.agentTool);
    const estimated = resolveCostUsd(existingCost, fresh);
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
