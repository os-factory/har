import * as path from 'path';
import { handleLaunch, handleStatus, handleVerify } from '../src/cli/commands/env';
import { getEnvironmentStatus, launchEnvironment, runVerification } from '../src/core/run-service';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

jest.mock('../src/core/run-service', () => ({
  getEnvironmentStatus: jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
  launchEnvironment: jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
  runVerification: jest.fn().mockResolvedValue({
    code: 1,
    stdout: '',
    stderr: '',
    verification: null,
  }),
  teardownEnvironment: jest.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' }),
}));

describe('env CLI delegation', () => {
  let exitSpy: jest.SpyInstance<never, [code?: string | number | null | undefined]>;

  beforeEach(() => {
    jest.clearAllMocks();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
  });

  afterEach(() => {
    exitSpy.mockRestore();
  });

  it('delegates launch to the core environment runner', async () => {
    await expect(
      handleLaunch({
        repo: FIXTURE,
        id: 2,
        worktree: false,
        claude: true,
        resume: false,
      }),
    ).rejects.toThrow('exit:0');

    expect(launchEnvironment).toHaveBeenCalledWith({
      repoPath: path.resolve(FIXTURE),
      agentId: 2,
      worktree: false,
      claude: true,
      resume: false,
      capture: false,
    });
  });

  it('delegates verification to the core verification runner', async () => {
    await expect(handleVerify({ repo: FIXTURE, id: 3, full: true })).rejects.toThrow(
      'exit:1',
    );

    expect(runVerification).toHaveBeenCalledWith({
      repoPath: path.resolve(FIXTURE),
      agentId: 3,
      full: true,
      capture: false,
    });
  });

  it('delegates status to the core status runner without forcing process exit', async () => {
    await handleStatus({ repo: FIXTURE });

    expect(getEnvironmentStatus).toHaveBeenCalledWith({
      repoPath: path.resolve(FIXTURE),
      capture: false,
    });
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
