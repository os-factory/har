import { describe, it, expect } from 'vitest';
import { RegisterRepoInputSchema, RunRecordSchema } from '@har/schemas';

describe('RegisterRepoInputSchema', () => {
  it('parses minimal repo registration', () => {
    const result = RegisterRepoInputSchema.parse({
      path: '/home/dev/my-app',
    });
    expect(result.path).toBe('/home/dev/my-app');
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
