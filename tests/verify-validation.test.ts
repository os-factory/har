import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { runVerification } from '../src/core/run-service';
import { computeWorktreeSnapshot } from '../src/core/change-batch';
import { listValidations } from '../src/core/validations';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

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

  it('does not fail verify when the repo is not a git checkout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-verify-nogit-'));
    fs.cpSync(path.join(FIXTURE, '.har'), path.join(dir, '.har'), { recursive: true });

    const result = await runVerification({ repoPath: dir, agentId: 1, full: true, capture: true });
    expect(result.verification?.status).toBe('pass');
    expect(listValidations(dir)).toEqual([]);
  });
});
