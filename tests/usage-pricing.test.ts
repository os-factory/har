import {
  enrichUsageWithPricing,
  estimateModelCostUsd,
  pricingModelCandidates,
  toGenaiPricesUsage,
} from '../packages/schemas/src/usage-pricing';
import {
  estimateCursorNativeCostUsd,
  isCursorNativeModel,
} from '../packages/schemas/src/cursor-pricing-overlay';
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
    ]);
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

  it('does not double-count cache read when input already includes it', () => {
    expect(
      toGenaiPricesUsage({
        tokensInput: 1200,
        tokensCacheRead: 1000,
        tokensCacheCreation: 50,
      }),
    ).toEqual({
      input_tokens: 1250,
      output_tokens: 0,
      cache_read_tokens: 1000,
      cache_write_tokens: 50,
    });
  });
});

describe('isCursorNativeModel', () => {
  it('detects composer and grok-4.5 slugs', () => {
    expect(isCursorNativeModel('composer-2.5-fast')).toBe(true);
    expect(isCursorNativeModel('cursor-grok-4.5-high-fast')).toBe(true);
    expect(isCursorNativeModel('claude-opus-4-8')).toBe(false);
  });
});

describe('estimateCursorNativeCostUsd', () => {
  it('prices grok-4.5 fast slugs from the temporary overlay', () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 100,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
    };
    expect(estimateCursorNativeCostUsd(usage, 'cursor-grok-4.5-high-fast')).toBeGreaterThan(0);
    expect(estimateCursorNativeCostUsd(usage, 'composer-2.5-fast')).toBeGreaterThan(0);
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

  it('prices cursor-native models via the temporary overlay', () => {
    const cost = estimateModelCostUsd(
      'cursor-grok-4.5-high-fast',
      { tokensInput: 1000, tokensOutput: 100 },
      'cursor',
    );
    expect(cost).not.toBeNull();
    expect(cost!).toBeGreaterThan(0);
  });

  it('prices composer models via the temporary overlay', () => {
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

  it('passes through rows without modelBreakdown', () => {
    const row = usage({ costUsd: null });
    expect(enrichUsageWithPricing(row)).toBe(row);
  });
});
