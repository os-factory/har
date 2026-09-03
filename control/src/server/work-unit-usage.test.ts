import { describe, expect, it } from 'vitest';
import { selectWorkUnitUsageRows, summarizeWorkUnitUsage } from './work-unit-usage';

const t = (iso: string) => new Date(iso);
const base = { workUnitId: null, attemptId: null, occupancyKey: null, agentId: 3, workDir: '/wt/a', firstSeenAt: t('2026-09-01T10:30:00Z') };

describe('selectWorkUnitUsageRows (#339)', () => {
  const attempts = [{ attemptId: 'att-1' }];
  const windows = [{ agentId: 3, workDir: '/wt/a', from: t('2026-09-01T10:00:00Z'), to: t('2026-09-01T12:00:00Z') }];

  it('takes sessions stamped with the unit, an attempt or an occupancy key', () => {
    const rows = [
      { ...base, id: 'unit', workUnitId: '338' },
      { ...base, id: 'attempt', attemptId: 'att-1' },
      { ...base, id: 'key', occupancyKey: 'attempt::att-1' },
      { ...base, id: 'other-unit', workUnitId: '999', attemptId: 'att-9', occupancyKey: 'attempt::att-9' },
    ];
    expect(selectWorkUnitUsageRows(rows, '338', attempts, windows).map((r) => r.id)).toEqual(['unit', 'attempt', 'key']);
  });

  it('recovers unstamped sessions from the attempt work-dir window only', () => {
    const rows = [
      { ...base, id: 'in-window' },
      { ...base, id: 'before', firstSeenAt: t('2026-09-01T09:00:00Z') },
      { ...base, id: 'after', firstSeenAt: t('2026-09-01T13:00:00Z') },
      { ...base, id: 'other-dir', workDir: '/wt/b' },
      { ...base, id: 'other-slot', agentId: 1 },
    ];
    expect(selectWorkUnitUsageRows(rows, '338', attempts, windows).map((r) => r.id)).toEqual(['in-window']);
  });
});

describe('summarizeWorkUnitUsage', () => {
  it('sums tokens and cost and reports the cost provenance', () => {
    expect(
      summarizeWorkUnitUsage([
        { tokensTotal: BigInt(1000), costUsd: 1.5, costSource: 'reported' },
        { tokensTotal: BigInt(500), costUsd: null, costSource: null },
      ]),
    ).toEqual({ tokensTotal: BigInt(1500), costUsd: 1.5, costSource: 'reported', sessionCount: 2 });
    expect(
      summarizeWorkUnitUsage([
        { tokensTotal: BigInt(1), costUsd: 1, costSource: 'reported' },
        { tokensTotal: BigInt(1), costUsd: 2, costSource: 'estimated' },
      ]).costSource,
    ).toBe('mixed');
    expect(summarizeWorkUnitUsage([])).toEqual({ tokensTotal: null, costUsd: null, costSource: null, sessionCount: 0 });
  });
});
