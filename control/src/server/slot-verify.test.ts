import { describe, expect, it } from 'vitest';
import { latestVerifyBySlot } from './slot-verify';

const t = (iso: string) => new Date(iso);
const slot = { repositoryId: 'r', slotId: 1, sessionCreatedAt: t('2026-09-01T10:00:00Z'), workDir: '/wt/a', occupancyKey: null };
const run = (over: Record<string, unknown>) => ({
  repositoryId: 'r', agentId: 1, stageId: 'verify', status: 'pass', startedAt: t('2026-09-01T11:00:00Z'), workDir: '/wt/a', occupancyKey: null, runId: 'x', ...over,
});

describe('latestVerifyBySlot (#339)', () => {
  it('picks the newest verify run of the current occupancy, ignoring other stages', () => {
    const out = latestVerifyBySlot(
      [
        run({ runId: 'teardown', stageId: 'teardown', startedAt: t('2026-09-01T12:00:00Z') }),
        run({ runId: 'old', startedAt: t('2026-09-01T09:00:00Z'), status: 'fail' }),
        run({ runId: 'other-dir', workDir: '/wt/b', startedAt: t('2026-09-01T11:30:00Z') }),
        run({ runId: 'latest', startedAt: t('2026-09-01T11:00:00Z') }),
        run({ runId: 'earlier', startedAt: t('2026-09-01T10:30:00Z'), status: 'fail' }),
      ],
      [slot],
    );
    expect(out.get('r:1')).toMatchObject({ runId: 'latest', status: 'pass' });
  });

  it('uses occupancy keys when both sides carry one', () => {
    const keyed = { ...slot, occupancyKey: 'attempt::a' };
    const out = latestVerifyBySlot(
      [run({ runId: 'prev', occupancyKey: 'attempt::z', startedAt: t('2026-09-01T12:00:00Z') }), run({ runId: 'mine', occupancyKey: 'attempt::a' })],
      [keyed],
    );
    expect(out.get('r:1')?.runId).toBe('mine');
    expect(latestVerifyBySlot([], [keyed]).size).toBe(0);
  });
});
