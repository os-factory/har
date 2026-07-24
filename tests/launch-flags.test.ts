import { buildLaunchFlagArgs, quoteShellArg } from '../src/core/local-executor';
import { LaunchEnvironmentInputSchema } from '../src/mcp/schemas';

describe('launch flag plumbing', () => {
  it('forwards replace/force/resume flags to launch.sh argv', () => {
    expect(
      buildLaunchFlagArgs({
        worktree: false,
        confirmReplace: true,
        force: true,
        resume: true,
        claude: true,
        workUnitId: 'ISSUE-123',
        attemptId: '11111111-1111-4111-8111-111111111111',
      }),
    ).toEqual([
      '--no-worktree',
      '--claude',
      '--replace',
      '--force',
      '--resume',
      '--work-id=ISSUE-123',
      '--attempt-id=11111111-1111-4111-8111-111111111111',
    ]);
  });

  it('shell-quotes values that contain spaces', () => {
    expect(quoteShellArg('--purpose=fix sqlite backend')).toBe(
      "'--purpose=fix sqlite backend'",
    );
    expect(quoteShellArg('--replace')).toBe('--replace');
  });

  it('accepts MCP launch input without purpose', () => {
    const parsed = LaunchEnvironmentInputSchema.parse({
      agentId: 1,
      resume: true,
    });
    expect(parsed.agentId).toBe(1);
    expect(parsed.resume).toBe(true);
    expect('purpose' in parsed).toBe(false);
  });
});
