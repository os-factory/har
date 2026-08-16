import { describe, expect, it } from 'vitest';
import {
  classifyWorktreeCleanup,
  isAutoCleanupRecommendation,
} from './worktree-cleanup-plan';

describe('worktree-cleanup-plan', () => {
  it('marks missing paths for dashboard clear', () => {
    const result = classifyWorktreeCleanup({
      active: false,
      dirty: false,
      sessionCreatedAt: new Date(),
      onDisk: false,
    });
    expect(result.recommendation).toBe('clear_missing');
  });

  it('marks stale clean sessions for teardown', () => {
    const created = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    const result = classifyWorktreeCleanup({
      active: true,
      dirty: false,
      sessionCreatedAt: created,
      onDisk: true,
    });
    expect(result.recommendation).toBe('teardown');
  });

  it('flags dirty sessions for review', () => {
    const result = classifyWorktreeCleanup({
      active: true,
      dirty: true,
      sessionCreatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
      onDisk: true,
    });
    expect(result.recommendation).toBe('review');
  });

  it('knows auto-approved recommendations', () => {
    expect(isAutoCleanupRecommendation('teardown')).toBe(true);
    expect(isAutoCleanupRecommendation('review')).toBe(false);
  });
});
