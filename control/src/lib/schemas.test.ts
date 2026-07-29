import { describe, it, expect } from 'vitest';
import {
  DeleteWorktreesInputSchema,
  RegisterRepoInputSchema,
  RunRecordSchema,
  SyncWorkUnitsInputSchema,
} from '@har/schemas';

describe('RegisterRepoInputSchema', () => {
  it('parses minimal repo registration', () => {
    const result = RegisterRepoInputSchema.parse({
      path: '/home/dev/my-app',
    });
    expect(result.path).toBe('/home/dev/my-app');
  });
});

describe('SyncWorkUnitsInputSchema', () => {
  it('parses provider-neutral work and attempt identity', () => {
    const result = SyncWorkUnitsInputSchema.parse({
      workUnits: [{
        workUnitId: 'github:acme/widget#123',
        source: 'github',
        createdAt: '2026-07-23T20:00:00.000Z',
        updatedAt: '2026-07-23T20:00:00.000Z',
      }],
      attempts: [{
        attemptId: '11111111-1111-4111-8111-111111111111',
        workUnitId: 'github:acme/widget#123',
        agentId: 1,
        createdAt: '2026-07-23T20:00:00.000Z',
      }],
    });
    expect(result.attempts[0].workUnitId).toBe(result.workUnits[0].workUnitId);
  });
});

describe('RunRecordSchema', () => {
  it('parses a run record', () => {
    const result = RunRecordSchema.parse({
      runId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      repoPath: '/tmp/repo',
      stageId: 'verify',
      status: 'pass',
      startedAt: new Date().toISOString(),
      trigger: 'mcp',
    });
    expect(result.trigger).toBe('mcp');
  });
});

describe('DeleteWorktreesInputSchema', () => {
  it('requires at least one worktree target', () => {
    const result = DeleteWorktreesInputSchema.parse({
      worktrees: [{ repoId: 'r1', slotId: 2 }],
    });
    expect(result.clearMissing).toBe(true);
    expect(() => DeleteWorktreesInputSchema.parse({ worktrees: [] })).toThrow();
  });
});
