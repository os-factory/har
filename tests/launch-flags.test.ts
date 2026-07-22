import { buildLaunchFlagArgs, quoteShellArg } from '../src/core/local-executor';
import { LaunchEnvironmentInputSchema } from '../src/mcp/schemas';

describe('launch purpose plumbing', () => {
  it('forwards --purpose to launch.sh argv', () => {
    expect(
      buildLaunchFlagArgs({
        worktree: true,
        purpose: 'fix sqlite backend',
      }),
    ).toEqual(['--purpose=fix sqlite backend']);
  });

  it('includes purpose alongside other launch flags', () => {
    expect(
      buildLaunchFlagArgs({
        worktree: false,
        confirmReplace: true,
        force: true,
        resume: true,
        claude: true,
        purpose: 'label',
      }),
    ).toEqual(['--no-worktree', '--claude', '--replace', '--force', '--resume', '--purpose=label']);
  });

  it('shell-quotes purpose values that contain spaces', () => {
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
});
