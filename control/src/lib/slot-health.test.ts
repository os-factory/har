import { describe, expect, it } from 'vitest';
import { describeSlotHealth, describeSlotVerify } from './slot-health';

const base = { active: true, detachedHead: false, dirty: false, ahead: 0, behind: 0, stale: false, baseBranch: 'main', branch: 'feat/x' };

describe('describeSlotHealth (#339)', () => {
  it('reads as one sentence with the drift facts', () => {
    expect(describeSlotHealth({ ...base, ahead: 2, behind: 113, stale: true, dirty: true })).toEqual({
      text: 'Active · 2 commits ahead, 113 behind main, uncommitted changes',
      tone: 'warn',
    });
    expect(describeSlotHealth(base)).toEqual({ text: 'Active · clean', tone: 'pass' });
    expect(describeSlotHealth({ ...base, ahead: 1, detachedHead: true }).text).toBe('Active · detached HEAD, 1 commit ahead');
    expect(describeSlotHealth({ ...base, detachedHead: true }).tone).toBe('fail');
  });

  it('flags a registry that says active while the path is gone', () => {
    expect(describeSlotHealth({ ...base, onDisk: false })).toEqual({ text: 'Active · worktree path missing on disk', tone: 'fail' });
  });

  it('describes idle slots by their last branch or cleanup advice', () => {
    expect(describeSlotHealth({ ...base, active: false })).toEqual({ text: 'Idle · last feat/x', tone: 'neutral' });
    expect(describeSlotHealth({ ...base, active: false, cleanupHint: 'safe to tear down (14d)' }).text).toBe('Idle · safe to tear down (14d)');
  });
});

describe('describeSlotVerify (#339)', () => {
  const now = new Date('2026-09-03T12:00:00Z');
  it('names the verify outcome and its age', () => {
    expect(describeSlotVerify({ lastVerifyStatus: 'pass', lastVerifyAt: '2026-09-03T11:46:00Z', now })).toEqual({ text: 'Verified 14m ago', tone: 'pass' });
    expect(describeSlotVerify({ lastVerifyStatus: 'fail', lastVerifyAt: '2026-09-03T10:00:00Z', now })).toEqual({ text: 'Verify fail 2h ago', tone: 'fail' });
    expect(describeSlotVerify({ lastVerifyStatus: 'bypass_warning', lastVerifyAt: null })).toEqual({ text: 'Verify bypassed', tone: 'warn' });
    expect(describeSlotVerify({ lastVerifyStatus: null, lastVerifyAt: null })).toEqual({ text: 'Not verified', tone: 'neutral' });
  });
});
