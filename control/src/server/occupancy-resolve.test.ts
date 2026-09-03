import { describe, expect, it } from 'vitest';
import { attemptIdFromOccupancyKey, occupancyKeyForAttempt, resolveRecordOccupancyKey } from './occupancy';

const candidates = [
  { slotId: 1, workDir: '/wt/a', sessionCreatedAt: new Date('2026-09-01T10:00:00Z'), occupancyKey: 'branch::feat::2026-09-01T10:00:00.000Z' },
  { slotId: 2, workDir: null, sessionCreatedAt: null, occupancyKey: null },
];

describe('resolveRecordOccupancyKey (#348)', () => {
  it('prefers the attempt the record is bound to', () => {
    expect(resolveRecordOccupancyKey({ attemptId: 'att-1', agentId: 1, workDir: '/wt/a', at: new Date() }, candidates)).toBe(
      'attempt::att-1',
    );
  });

  it('falls back to the slot occupancy when work dir and time match', () => {
    expect(
      resolveRecordOccupancyKey({ agentId: 1, workDir: '/wt/a', at: new Date('2026-09-01T10:05:00Z') }, candidates),
    ).toBe('branch::feat::2026-09-01T10:00:00.000Z');
  });

  it('refuses records from another worktree or from before the session began', () => {
    expect(resolveRecordOccupancyKey({ agentId: 1, workDir: '/wt/b', at: new Date('2026-09-01T10:05:00Z') }, candidates)).toBeNull();
    expect(resolveRecordOccupancyKey({ agentId: 1, workDir: '/wt/a', at: new Date('2026-09-01T09:00:00Z') }, candidates)).toBeNull();
    expect(resolveRecordOccupancyKey({ agentId: 2, workDir: '/x', at: new Date() }, candidates)).toBeNull();
    expect(resolveRecordOccupancyKey({ workDir: '/wt/a', at: new Date() }, candidates)).toBeNull();
  });

  it('round-trips attempt keys', () => {
    expect(attemptIdFromOccupancyKey(occupancyKeyForAttempt('att-9'))).toBe('att-9');
    expect(attemptIdFromOccupancyKey('branch::main::2026')).toBeNull();
    expect(attemptIdFromOccupancyKey(null)).toBeNull();
  });
});
