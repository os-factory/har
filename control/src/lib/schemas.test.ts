import { describe, it, expect } from 'vitest';
import {
  DeleteWorktreesInputSchema,
  RegisterRepoInputSchema,
  ResetMissionControlInputSchema,
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
  it('parses short work unit ids with source metadata', () => {
    const result = SyncWorkUnitsInputSchema.parse({
      workUnits: [{
        workUnitId: 'widget-123',
        source: 'github',
        sourceUrl: 'https://github.com/acme/widget/issues/123',
        createdAt: '2026-07-23T20:00:00.000Z',
        updatedAt: '2026-07-23T20:00:00.000Z',
      }],
      attempts: [{
        attemptId: '11111111-1111-4111-8111-111111111111',
        workUnitId: 'widget-123',
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

describe('ResetMissionControlInputSchema', () => {
  it('requires confirm RESET and defaults scrubLocalHarness', () => {
    const result = ResetMissionControlInputSchema.parse({ confirm: 'RESET' });
    expect(result.scrubLocalHarness).toBe(true);
    expect(() => ResetMissionControlInputSchema.parse({ confirm: 'yes' })).toThrow();
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
