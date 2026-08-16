import { describe, expect, it } from 'vitest';
import {
  compareTrajectoryOrder,
  cursorForTrajectory,
  decodeTrajectoryCursor,
  stableTrajectoryKey,
} from './trajectory-ledger';

describe('trajectory ledger ordering', () => {
  it('round-trips opaque cursors and orders content facts deterministically', () => {
    const first = {
      sequence: 8,
      eventTimestamp: new Date('2026-08-14T10:00:00.000Z'),
      source: 'otel',
      sourceEventId: 'event-1',
      contentKey: 'prompt',
      id: 'row-a',
    };
    const second = { ...first, contentKey: 'response', id: 'row-b' };
    const firstCursor = decodeTrajectoryCursor(cursorForTrajectory(first));
    const secondCursor = decodeTrajectoryCursor(cursorForTrajectory(second));

    expect(firstCursor).toMatchObject({
      sequence: 8,
      sourceEventId: 'event-1',
      contentKey: 'prompt',
    });
    expect(compareTrajectoryOrder(firstCursor, secondCursor)).toBeLessThan(0);
  });

  it('hashes object keys independently of insertion order', () => {
    expect(stableTrajectoryKey({ kind: 'prompt', body: 'hello' })).toBe(
      stableTrajectoryKey({ body: 'hello', kind: 'prompt' }),
    );
  });

  it('rejects malformed cursors', () => {
    expect(() => decodeTrajectoryCursor('not-a-cursor')).toThrow('Invalid trajectory cursor');
  });
});

describe('trajectory retention policy', () => {
  it('treats zero days as keep-forever so expire is a no-op without a cutoff', async () => {
    const previous = process.env.HAR_TRAJECTORY_RETENTION_DAYS;
    process.env.HAR_TRAJECTORY_RETENTION_DAYS = '0';
    const { expireTrajectoryRecords } = await import('./trajectory-ledger');
    await expect(expireTrajectoryRecords()).resolves.toBe(0);
    if (previous == null) delete process.env.HAR_TRAJECTORY_RETENTION_DAYS;
    else process.env.HAR_TRAJECTORY_RETENTION_DAYS = previous;
  });
});
