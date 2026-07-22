import { describe, expect, it } from 'vitest';
import type { AgentSlotStatus } from '@har/schemas';
import { buildAgentSlotSyncFields } from './slot-sync-fields';

function activeSlot(overrides: Partial<AgentSlotStatus> = {}): AgentSlotStatus {
  return {
    agentId: 1,
    active: true,
    harnessUsage: 'cli',
    workDir: '/tmp/wt',
    worktreePath: '/tmp/wt',
    branch: 'feat-demo-har-agent-1-abcd',
    previewUrls: { frontend: 'http://localhost:3000' },
    dirty: true,
    ahead: 2,
    behind: 0,
    stale: false,
    detachedHead: false,
    purpose: 'demo',
    ...overrides,
  };
}

describe('buildAgentSlotSyncFields', () => {
  it('keeps live session fields when the slot is active', () => {
    const fields = buildAgentSlotSyncFields(activeSlot());
    expect(fields.active).toBe(true);
    expect(fields.worktreePath).toBe('/tmp/wt');
    expect(fields.workDir).toBe('/tmp/wt');
    expect(fields.branch).toBe('feat-demo-har-agent-1-abcd');
    expect(fields.previewUrls).toEqual({ frontend: 'http://localhost:3000' });
    expect(fields.dirty).toBe(true);
    expect(fields.ahead).toBe(2);
  });

  it('nulls worktree path, preview, and drift when idle (teardown sync)', () => {
    const fields = buildAgentSlotSyncFields(
      activeSlot({
        active: false,
        workDir: undefined,
        worktreePath: undefined,
        previewUrls: undefined,
        dirty: undefined,
        ahead: undefined,
        behind: undefined,
        stale: undefined,
        detachedHead: undefined,
        branch: undefined,
      }),
    );

    expect(fields.active).toBe(false);
    expect(fields.workDir).toBeNull();
    expect(fields.worktreePath).toBeNull();
    expect(fields.previewUrls).toBeNull();
    expect(fields.dirty).toBeNull();
    expect(fields.ahead).toBeNull();
    expect(fields.behind).toBeNull();
    expect(fields.stale).toBeNull();
    expect(fields.detachedHead).toBeNull();
    // Omitted branch on idle → leave previous DB value (field absent).
    expect(fields).not.toHaveProperty('branch');
  });

  it('still records an explicit last branch when idle sync includes it', () => {
    const fields = buildAgentSlotSyncFields(
      activeSlot({
        active: false,
        worktreePath: undefined,
        workDir: undefined,
        branch: 'feat-demo-har-agent-1-abcd',
      }),
    );
    expect(fields.worktreePath).toBeNull();
    expect(fields.branch).toBe('feat-demo-har-agent-1-abcd');
  });

  it('clears branch when an active sync omits it', () => {
    const fields = buildAgentSlotSyncFields(
      activeSlot({
        branch: undefined,
      }),
    );
    expect(fields.branch).toBeNull();
  });
});
