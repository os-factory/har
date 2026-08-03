import { describe, expect, it } from 'vitest';
import {
  formatCostUsd,
  formatModelId,
  formatTokens,
  matchesUsageSearch,
  modelsFromBreakdown,
  modelTotalsFromBreakdown,
} from './usage-models';

describe('usage-models', () => {
  it('lists model ids from breakdown', () => {
    expect(
      modelsFromBreakdown({
        'grok-4.5': { tokensTotal: 10 },
        'cursor-grok-4.5-high-fast': { tokensTotal: 2 },
      }),
    ).toEqual(['cursor-grok-4.5-high-fast', 'grok-4.5']);
  });

  it('formats model ids', () => {
    expect(formatModelId('cursor-grok-4.5-high-fast')).toBe('grok-4.5-high-fast');
    expect(formatModelId('grok-4.5')).toBe('grok-4.5');
  });

  it('returns totals entries', () => {
    expect(
      modelTotalsFromBreakdown({
        'grok-4.5': { tokensInput: 5, tokensOutput: 1, tokensTotal: 6, costUsd: 0.0042 },
      }),
    ).toEqual([
      { model: 'grok-4.5', totals: { tokensInput: 5, tokensOutput: 1, tokensTotal: 6, costUsd: 0.0042 } },
    ]);
  });

  it('formats cost values', () => {
    expect(formatCostUsd(null)).toBe('—');
    expect(formatCostUsd(0.1234)).toBe('$0.1234');
  });

  it('formats token counts', () => {
    expect(formatTokens(42)).toBe('42');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(2_500_000)).toBe('2.50M');
  });

  it('matches usage search across repo, slot, session, agent, and sources', () => {
    const row = {
      repositoryPath: '/home/user/projects/har-project',
      agentId: 2,
      sessionKey: 'main-abcd-har-agent-2-wxyz',
      agentTool: 'claude_code',
      sources: ['otel', 'harvest'],
    };
    expect(matchesUsageSearch(row, '', (t) => t)).toBe(true);
    expect(matchesUsageSearch(row, 'har-project', (t) => t)).toBe(true);
    expect(matchesUsageSearch(row, '2', (t) => t)).toBe(true);
    expect(matchesUsageSearch(row, 'wxyz', (t) => t)).toBe(true);
    expect(matchesUsageSearch(row, 'Claude', (t) => (t === 'claude_code' ? 'Claude' : t))).toBe(
      true,
    );
    expect(matchesUsageSearch(row, 'harvest', (t) => t)).toBe(true);
    expect(matchesUsageSearch(row, 'zzz-missing', (t) => t)).toBe(false);
  });
});

