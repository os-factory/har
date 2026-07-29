import { describe, expect, it } from 'vitest';
import { formatCostUsd, formatModelId, modelsFromBreakdown, modelTotalsFromBreakdown } from './usage-models';

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
});
