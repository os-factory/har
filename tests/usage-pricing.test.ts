import {
  enrichUsageWithPricing,
  estimateModelCostUsd,
  pricingModelCandidates,
  toGenaiPricesUsage,
} from '../packages/schemas/src/usage-pricing';
import type { AgentSessionUsage } from '../packages/schemas/src/schema';

function usage(overrides: Partial<AgentSessionUsage> = {}): AgentSessionUsage {
  return {
    sessionKey: 'feat/x',
    agentId: 1,
    agentTool: 'claude_code',
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    tokensTotal: 0,
    sources: [],
    harvestVersion: 0,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('pricingModelCandidates', () => {
  it('strips cursor- prefix as a fallback candidate', () => {
    expect(pricingModelCandidates('cursor-grok-4.5-high-fast')).toEqual([
      'cursor-grok-4.5-high-fast',
      'grok-4.5-high-fast',
      'grok-4.5-fast',
    ]);
  });

  it('maps -high tier suffixes to genai-prices catalog ids', () => {
    expect(pricingModelCandidates('grok-4.5-high')).toEqual(['grok-4.5-high', 'grok-4.5']);
  });
});

describe('toGenaiPricesUsage', () => {
  it('builds inclusive input_tokens for Claude-style disjoint buckets', () => {
    expect(
      toGenaiPricesUsage({
        tokensInput: 2,
        tokensCacheCreation: 26207,
      }),
    ).toEqual({
      input_tokens: 26209,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 26207,
    });
  });

  it('sums disjoint buckets into the inclusive input parent', () => {
    expect(
      toGenaiPricesUsage({
        tokensInput: 1200,
        tokensCacheRead: 1000,
        tokensCacheCreation: 50,
      }),
    ).toEqual({
      input_tokens: 2250,
      output_tokens: 0,
      cache_read_tokens: 1000,
      cache_write_tokens: 50,
    });
  });

  it('keeps uncached input tokens whole when it exceeds cache reads', () => {
    expect(
      toGenaiPricesUsage({
        tokensInput: 5000,
        tokensCacheRead: 100,
      }),
    ).toEqual({
      input_tokens: 5100,
      output_tokens: 0,
      cache_read_tokens: 100,
      cache_write_tokens: 0,
    });
  });
});

describe('estimateModelCostUsd', () => {
  it('prices anthropic models from per-model token totals', () => {
    const cost = estimateModelCostUsd(
      'claude-opus-4-8',
      {
        tokensInput: 1000,
        tokensOutput: 100,
        tokensCacheRead: 200,
        tokensCacheCreation: 50,
      },
      'claude_code',
    );
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });

  it('prices Claude cache_creation rows without validation errors', () => {
    const cost = estimateModelCostUsd(
      'claude-opus-4-8',
      {
        tokensInput: 2,
        tokensCacheCreation: 26207,
      },
      'claude_code',
    );
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });

  it('returns null when a model is unknown to the catalog', () => {
    expect(
      estimateModelCostUsd(
        'totally-unknown-model-slug',
        { tokensInput: 1000, tokensOutput: 100 },
        'cursor',
      ),
    ).toBeNull();
  });

  it('prices cursor-native models from the bundled genai-prices catalog', () => {
    const cost = estimateModelCostUsd(
      'cursor-grok-4.5-high-fast',
      { tokensInput: 1000, tokensOutput: 100 },
      'cursor',
    );
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });

  it('prices composer models from the bundled genai-prices catalog', () => {
    const cost = estimateModelCostUsd(
      'composer-2.5',
      { tokensInput: 10_000, tokensOutput: 1000 },
      'cursor',
    );
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });
});

describe('enrichUsageWithPricing', () => {
  it('adds per-model and session costUsd from modelBreakdown', () => {
    const enriched = enrichUsageWithPricing(
      usage({
        costUsd: null,
        modelBreakdown: {
          'claude-opus-4-8': {
            tokensInput: 1000,
            tokensOutput: 100,
            tokensTotal: 1100,
          },
        },
      }),
    );
    expect(enriched.costUsd).not.toBeNull();
    expect(enriched.costUsd!).toBeGreaterThan(0);
    const breakdown = enriched.modelBreakdown as Record<string, { costUsd?: number }>;
    expect(breakdown['claude-opus-4-8'].costUsd).toBeGreaterThan(0);
  });

  it('keeps agent-reported session cost when it exceeds the estimate', () => {
    const enriched = enrichUsageWithPricing(
      usage({
        costUsd: 9.99,
        modelBreakdown: {
          'claude-opus-4-8': { tokensInput: 100, tokensOutput: 10, tokensTotal: 110 },
        },
      }),
    );
    expect(enriched.costUsd).toBe(9.99);
  });

  it('re-prices a breakdown whose tokens grew past its stored per-model cost', () => {
    const first = enrichUsageWithPricing(
      usage({
        modelBreakdown: {
          'claude-opus-5-5': { tokensInput: 1000, tokensOutput: 100, tokensTotal: 1100 },
        },
      }),
    );
    const storedCost = (first.modelBreakdown as Record<string, { costUsd: number }>)['claude-opus-5-5']
      .costUsd;

    // What Mission Control merges on the next sync: more tokens, old cost.
    const resynced = enrichUsageWithPricing(
      usage({
        modelBreakdown: {
          'claude-opus-5-5': {
            tokensInput: 10_000,
            tokensOutput: 1000,
            tokensTotal: 11_000,
            costUsd: storedCost,
          },
        },
      }),
    );
    expect(resynced.costUsd!).toBeGreaterThan(first.costUsd!);
  });

  it('keeps a per-model cost that is higher than the estimate', () => {
    const enriched = enrichUsageWithPricing(
      usage({
        modelBreakdown: {
          'claude-opus-5-5': { tokensInput: 10, tokensOutput: 1, tokensTotal: 11, costUsd: 5 },
        },
      }),
    );
    expect(enriched.costUsd).toBe(5);
  });

  it('passes through rows without modelBreakdown', () => {
    const row = usage({ costUsd: null });
    expect(enrichUsageWithPricing(row)).toBe(row);
  });
});

describe('Claude Opus 5.5 pricing', () => {
  // Real `claude_code.api_request` events: the cost Claude Code reported for
  // each request. genai-prices < 0.2 matched `claude-opus-5-5` by prefix to
  // Opus 5 and estimated about twice these. The remaining gap is cache writes:
  // Claude Code writes the 1-hour cache (2x input), genai-prices prices the
  // 5-minute one (1.25x input), so write-heavy requests read a few % low.
  const reported = [
    { tokensInput: 2, tokensCacheRead: 358_381, tokensCacheCreation: 315, tokensOutput: 383, costUsd: 0.0818642 },
    { tokensInput: 2, tokensCacheRead: 172_535, tokensCacheCreation: 634, tokensOutput: 256, costUsd: 0.044707 },
    { tokensInput: 2, tokensCacheRead: 114_228, tokensCacheCreation: 1_102, tokensOutput: 810, costUsd: 0.0478696 },
  ];

  it.each(reported)('estimates within 10% of the reported cost ($costUsd)', ({ costUsd, ...totals }) => {
    const estimate = estimateModelCostUsd('claude-opus-5-5', totals, 'claude_code');
    expect(estimate).not.toBeNull();
    expect(Math.abs(estimate! - costUsd) / costUsd).toBeLessThan(0.1);
  });
});
