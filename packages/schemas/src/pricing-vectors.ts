import { estimateModelCostUsd, GENAI_PRICES_LABEL, type ModelUsageTotals } from './model-pricing';

/**
 * Pricing test vectors (ADR 0005 section 5): token counts and the cost HAR's
 * shared pricing (`model-pricing.ts`, genai-prices) gives them. Every receiver
 * prices tokens at ingest; a receiver in another codebase checks it gives the
 * same numbers by pricing these rows itself. `pricing-vectors.json` holds the
 * generated rows; Mission Control's tests fail when it is out of date.
 *
 * Token buckets are disjoint, as every HAR producer reports them: uncached
 * input, output, cache reads, cache writes.
 */

export interface PricingVectorCase {
  /** The agent tool whose usage it is (`claude_code`, `codex`, `cursor`): it selects the provider. */
  provider: string;
  model: string;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
}

export interface PricingVector extends PricingVectorCase {
  /** USD, unrounded; null when HAR does not price it (an unpriced tool or a model unknown to the catalog). */
  expectedCostUsd: number | null;
  /** The genai-prices release the expectation was computed with. */
  pricedWith: string;
}

const T = (tokensInput: number, tokensOutput: number, tokensCacheRead = 0, tokensCacheCreation = 0) => ({
  tokensInput,
  tokensOutput,
  tokensCacheRead,
  tokensCacheCreation,
});

export const PRICING_VECTOR_CASES: readonly PricingVectorCase[] = [
  { provider: 'claude_code', model: 'claude-sonnet-4-5', ...T(1_000, 500) },
  { provider: 'claude_code', model: 'claude-sonnet-4-5', ...T(1_200, 800, 45_000, 3_000) },
  { provider: 'claude_code', model: 'claude-sonnet-4-5-20250929', ...T(250_000, 4_000, 10_000, 0) },
  { provider: 'claude_code', model: 'claude-opus-4-1', ...T(3_000, 1_500, 120_000, 8_000) },
  { provider: 'claude_code', model: 'claude-haiku-4-5', ...T(20_000, 2_000, 0, 0) },
  { provider: 'codex', model: 'gpt-5', ...T(12_000, 3_000, 40_000, 0) },
  { provider: 'codex', model: 'gpt-5-codex', ...T(8_000, 2_500, 64_000, 0) },
  { provider: 'codex', model: 'gpt-4.1', ...T(5_000, 1_000) },
  { provider: 'codex', model: 'o3', ...T(2_000, 6_000) },
  // Zero tokens and unpriced usage price to null.
  { provider: 'claude_code', model: 'claude-sonnet-4-5', ...T(0, 0) },
  { provider: 'cursor', model: 'claude-4.5-sonnet', ...T(10_000, 2_000) },
  { provider: 'codex', model: 'no-such-model-in-the-catalog', ...T(1_000, 1_000) },
];

/** Price every case with HAR's shared pricing. */
export function generatePricingVectors(cases: readonly PricingVectorCase[] = PRICING_VECTOR_CASES): PricingVector[] {
  return cases.map((vector) => {
    const totals: ModelUsageTotals = {
      tokensInput: vector.tokensInput,
      tokensOutput: vector.tokensOutput,
      tokensCacheRead: vector.tokensCacheRead,
      tokensCacheCreation: vector.tokensCacheCreation,
    };
    return {
      ...vector,
      expectedCostUsd: estimateModelCostUsd(vector.model, totals, vector.provider),
      pricedWith: GENAI_PRICES_LABEL,
    };
  });
}
