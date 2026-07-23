import { buildLaunchFlagArgs, quoteShellArg } from '../src/core/local-executor';
import { LaunchEnvironmentInputSchema } from '../src/mcp/schemas';

describe('launch flag plumbing', () => {
  it('forwards replace/force/resume/purpose flags to launch.sh argv', () => {
    expect(
      buildLaunchFlagArgs({
        worktree: false,
        confirmReplace: true,
        force: true,
        resume: true,
        claude: true,
        purpose: 'label',
      }),
    ).toEqual([
      '--no-worktree',
      '--claude',
      '--replace',
      '--force',
      '--resume',
      '--purpose=label',
    ]);
  });

  it('forwards --purpose alone', () => {
    expect(
      buildLaunchFlagArgs({
        worktree: true,
        purpose: 'fix sqlite backend',
      }),
    ).toEqual(['--purpose=fix sqlite backend']);
  });

  it('shell-quotes values that contain spaces', () => {
    expect(quoteShellArg('--purpose=fix sqlite backend')).toBe(
      "'--purpose=fix sqlite backend'",
    );
    expect(quoteShellArg('--replace')).toBe('--replace');
  });

  it('accepts purpose on MCP launch input', () => {
    const parsed = LaunchEnvironmentInputSchema.parse({
      agentId: 1,
      purpose: 'wire launch purpose',
    });
    expect(parsed.purpose).toBe('wire launch purpose');
  });

  it('accepts MCP launch input without purpose', () => {
    const parsed = LaunchEnvironmentInputSchema.parse({
      agentId: 1,
      resume: true,
    });
    expect(parsed.agentId).toBe(1);
    expect(parsed.resume).toBe(true);
    expect(parsed.purpose).toBeUndefined();
  });
});
