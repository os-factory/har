import { snapshotMemo, withStatusSnapshot } from '../src/core/status-snapshot';

describe('status snapshot', () => {
  it('computes each key once inside a snapshot, and every time outside one', async () => {
    let reads = 0;
    const read = () => snapshotMemo('pm2-jlist', () => ++reads);

    expect(read()).toBe(1);
    expect(read()).toBe(2);

    await withStatusSnapshot(async () => {
      expect(read()).toBe(3);
      await Promise.resolve();
      // Still the same snapshot across an await, and in a nested one.
      expect(read()).toBe(3);
      expect(withStatusSnapshot(read)).toBe(3);
    });

    // A new snapshot reads the machine again.
    expect(withStatusSnapshot(read)).toBe(4);
    expect(read()).toBe(5);
  });

  it('keeps an undefined result (a failed read) for the rest of the snapshot', () => {
    let reads = 0;
    withStatusSnapshot(() => {
      const read = () => snapshotMemo('git-common-dir\0/nowhere', () => (reads++, undefined));
      expect(read()).toBeUndefined();
      expect(read()).toBeUndefined();
    });
    expect(reads).toBe(1);
  });
});
