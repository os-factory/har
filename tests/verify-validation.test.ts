import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { runVerification } from '../src/core/run-service';
import { computeWorktreeSnapshot } from '../src/core/change-batch';
import { listValidations } from '../src/core/validations';
import { buildVerifyPlan } from '../src/runtime';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

// #234: verify runs through the package runtime; stub the plan so the suite
// exercises validation recording, not the stage runner.
jest.mock('../src/runtime', () => {
  const actual = jest.requireActual('../src/runtime');
  return {
    ...actual,
    buildVerifyPlan: jest.fn((_repo: string, agentId: number) => ({
      shellCommand:
        "echo '" +
        JSON.stringify({ status: 'pass', agent_id: agentId, total_ms: 10, stages: [{ name: 'smoke', pass: true }] }) +
        "'",
      cwd: process.cwd(),
      env: process.env,
    })),
  };
});



function sh(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initHarnessRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-verify-val-'));
  fs.cpSync(path.join(FIXTURE, '.har'), path.join(dir, '.har'), { recursive: true });
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email har@test.local');
  sh(dir, 'git config user.name har');
  fs.writeFileSync(path.join(dir, 'app.txt'), 'v1\n');
  sh(dir, 'git add -A');
  sh(dir, 'git commit -q -m init');
  return dir;
}

describe('verify records validations', () => {
  it('writes a pass validation for the current change batch on verify --full', async () => {
    const dir = initHarnessRepo();
    fs.writeFileSync(path.join(dir, 'app.txt'), 'v2\n');

    const result = await runVerification({ repoPath: dir, agentId: 1, full: true, capture: true });
    expect(result.verification?.status).toBe('pass');

    const validations = listValidations(dir);
    expect(validations).toHaveLength(1);
    expect(validations[0]).toMatchObject({ status: 'pass', full: true, agentId: 1 });
    expect(validations[0].treeHash).toBe(computeWorktreeSnapshot(dir).treeHash);
    expect(validations[0].changedFiles).toEqual([{ path: 'app.txt', status: 'M' }]);
    expect(validations[0].runId).toBeTruthy();
  });

  it('records full=false for a non-full verify', async () => {
    const dir = initHarnessRepo();
    await runVerification({ repoPath: dir, agentId: 1, capture: true });
    expect(listValidations(dir)[0]).toMatchObject({ status: 'pass', full: false });
  });

  describe('after-stages hook (opt-in line gates, BE-3795)', () => {
    it('keeps a pass when every extra check passes', async () => {
      const dir = initHarnessRepo();
      const afterStages = jest.fn(async () => [{ name: 'line:a', pass: true }]);

      const result = await runVerification({ repoPath: dir, agentId: 1, full: true, capture: true, afterStages });

      expect(afterStages).toHaveBeenCalledTimes(1);
      expect(result.code).toBe(0);
      expect(result.verification?.status).toBe('pass');
      expect(result.extraChecks).toEqual([{ name: 'line:a', pass: true }]);
      expect(listValidations(dir)[0]).toMatchObject({ status: 'pass', full: true });
    });

    it('fails verify and records a failed validation when an extra check fails', async () => {
      const dir = initHarnessRepo();
      const afterStages = jest.fn(async () => [
        { name: 'line:a', pass: true },
        { name: 'line:b', pass: false, detail: 'b-gate (from S2): fail' },
      ]);

      const result = await runVerification({ repoPath: dir, agentId: 1, full: true, capture: true, afterStages });

      expect(result.code).toBe(1);
      expect(result.verification?.status).toBe('fail');
      // Stage results stay as the stages reported them.
      expect(result.verification?.stages).toEqual([{ name: 'smoke', pass: true }]);
      expect(result.extraChecks?.find((c) => !c.pass)?.name).toBe('line:b');
      // `complete` must not reuse this validation.
      expect(listValidations(dir)[0]).toMatchObject({ status: 'fail', full: true });
    });

    it('does not run the hook when the stages fail', async () => {
      const dir = initHarnessRepo();
      (buildVerifyPlan as jest.Mock).mockImplementationOnce((_repo: string, agentId: number) => ({
        shellCommand:
          "echo '" +
          JSON.stringify({ status: 'fail', agent_id: agentId, stages: [{ name: 'smoke', pass: false }] }) +
          "'; exit 1",
        cwd: process.cwd(),
        env: process.env,
      }));
      const afterStages = jest.fn(async () => [{ name: 'line:a', pass: true }]);

      const result = await runVerification({ repoPath: dir, agentId: 1, capture: true, afterStages });

      expect(afterStages).not.toHaveBeenCalled();
      expect(result.code).not.toBe(0);
      expect(result.extraChecks).toBeUndefined();
    });
  });

  it('does not fail verify when the repo is not a git checkout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-verify-nogit-'));
    fs.cpSync(path.join(FIXTURE, '.har'), path.join(dir, '.har'), { recursive: true });

    const result = await runVerification({ repoPath: dir, agentId: 1, full: true, capture: true });
    expect(result.verification?.status).toBe('pass');
    expect(listValidations(dir)).toEqual([]);
  });
});
