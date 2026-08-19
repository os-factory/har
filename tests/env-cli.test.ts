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
    (runVerification as jest.Mock).mockResolvedValue({
      code: 1,
      stdout: '',
      stderr: '',
      verification: null,
    });
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

  it('does not reprint the verify JSON contract on stdout', async () => {
    (runVerification as jest.Mock).mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        status: 'pass',
        agent_id: 3,
        stages: [{ name: 'typecheck', pass: true, ms: 10, output: 'huge log' }],
      }),
      stderr: '  → typecheck... ✓',
      verification: {
        status: 'pass',
        agent_id: 3,
        total_ms: 10,
        stages: [{ name: 'typecheck', pass: true, ms: 10, output: 'huge log' }],
      },
    });
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await expect(handleVerify({ repo: FIXTURE, id: 3, full: true })).rejects.toThrow('exit:0');

    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it('prints slim verification JSON with --json', async () => {
    (runVerification as jest.Mock).mockResolvedValue({
      code: 1,
      stdout: '{"status":"fail","agent_id":3,"stages":[]}',
      stderr: '',
      verification: {
        status: 'fail',
        agent_id: 3,
        total_ms: 50,
        stages: [
          { name: 'typecheck', pass: true, ms: 10, output: 'ok' },
          { name: 'unit-tests', pass: false, ms: 40, output: 'FAIL spec.ts' },
        ],
      },
    });
    const chunks: string[] = [];
    const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });

    await expect(handleVerify({ repo: FIXTURE, id: 3, full: true, json: true })).rejects.toThrow(
      'exit:1',
    );

    expect(runVerification).toHaveBeenCalledWith({
      repoPath: path.resolve(FIXTURE),
      agentId: 3,
      full: true,
      capture: true,
    });
    const payload = JSON.parse(chunks.join(''));
    expect(payload).toEqual({
      status: 'fail',
      agent_id: 3,
      total_ms: 50,
      stages: [
        { name: 'typecheck', pass: true, ms: 10 },
        { name: 'unit-tests', pass: false, ms: 40, output: 'FAIL spec.ts' },
      ],
    });
    writeSpy.mockRestore();
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
