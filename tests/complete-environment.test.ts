import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  completeEnvironment,
  shouldReverifyOnComplete,
} from '../src/core/run-service';
import { recordValidation } from '../src/core/validations';
import { createWorkAttempt, findWorkUnit, upsertWorkUnit } from '../src/core/work-units';
import { getSlotRegistryPath } from '../src/core/slot-registry';
import { buildVerifyPlan, teardownSession } from '../src/runtime';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

jest.mock('../src/runtime', () => {
  const actual = jest.requireActual('../src/runtime');
  return {
    ...actual,
    launchSession: jest.fn(async () => ({ code: 0 })),
    teardownSession: jest.fn(async (options: { agentId: number; out?: (line: string) => void }) => {
      options.out?.(`==> Tearing down agent ${options.agentId}...`);
      return { code: 0 };
    }),
    runSetupInfra: jest.fn(async () => ({ code: 0 })),
    runAgentOp: jest.fn(async () => ({ code: 0 })),
    buildVerifyPlan: jest.fn((_repo: string, agentId: number) => ({
      shellCommand:
        "echo '" +
        JSON.stringify({
          status: 'pass',
          agent_id: agentId,
          total_ms: 10,
          stages: [{ name: 'smoke', pass: true }],
        }) +
        "'",
      cwd: process.cwd(),
      env: process.env,
    })),
  };
});

function sh(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-complete-'));
  fs.cpSync(path.join(FIXTURE, '.har'), path.join(dir, '.har'), { recursive: true });
  for (const name of ['runs', 'slots', 'work-units', 'work-attempts', 'validation-bindings']) {
    fs.rmSync(path.join(dir, '.har', name), { recursive: true, force: true });
  }
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email har@test.local');
  sh(dir, 'git config user.name har');
  fs.writeFileSync(path.join(dir, 'app.txt'), 'v1\n');
  sh(dir, 'git add -A');
  sh(dir, 'git commit -q -m init');
  return dir;
}

function writeActiveSlot(repoPath: string, extra: Record<string, unknown> = {}): void {
  const file = getSlotRegistryPath(repoPath, 1);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      agentId: 1,
      projectName: 'minimal',
      mode: 'root',
      workDir: repoPath,
      worktreePath: repoPath,
      branch: 'session-branch',
      createdAt: new Date().toISOString(),
      status: 'active',
      ...extra,
    }),
  );
}

describe('shouldReverifyOnComplete', () => {
  it('skips by default and only re-runs when verify is true or skipVerify is false', () => {
    expect(shouldReverifyOnComplete({})).toBe(false);
    expect(shouldReverifyOnComplete({ skipVerify: true })).toBe(false);
    expect(shouldReverifyOnComplete({ verify: true })).toBe(true);
    expect(shouldReverifyOnComplete({ skipVerify: false })).toBe(true);
    expect(shouldReverifyOnComplete({ verify: true, skipVerify: true })).toBe(true);
  });
});

describe('completeEnvironment (#324)', () => {
  const mockedPlan = buildVerifyPlan as jest.MockedFunction<typeof buildVerifyPlan>;
  const mockedTeardown = teardownSession as jest.MockedFunction<typeof teardownSession>;

  beforeEach(() => {
    mockedPlan.mockClear();
    mockedTeardown.mockClear();
  });

  it('reuses a matching passing full validation and does not re-run verify', async () => {
    const dir = initRepo();
    writeActiveSlot(dir);
    const validation = recordValidation({
      checkoutDir: dir,
      harnessRoot: dir,
      status: 'pass',
      full: true,
      agentId: 1,
    });

    const result = await completeEnvironment({ repoPath: dir, agentId: 1, capture: true });

    expect(result.code).toBe(0);
    expect(mockedPlan).not.toHaveBeenCalled();
    expect(mockedTeardown).toHaveBeenCalledTimes(1);
    expect(result.stdout).toContain(`Reused passing full validation ${validation.validationId}`);
    expect(result.stdout).toContain('Branch kept: session-branch');
  });

  it('refuses when the tree drifted since the last passing full validation', async () => {
    const dir = initRepo();
    writeActiveSlot(dir);
    recordValidation({ checkoutDir: dir, harnessRoot: dir, status: 'pass', full: true });
    fs.writeFileSync(path.join(dir, 'app.txt'), 'v2\n');

    const result = await completeEnvironment({ repoPath: dir, agentId: 1, capture: true });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No passing full validation matches the current worktree');
    expect(result.stderr).toContain('har env complete 1 --verify');
    expect(mockedPlan).not.toHaveBeenCalled();
    expect(mockedTeardown).not.toHaveBeenCalled();
  });

  it('refuses a quick-only validation for the current tree', async () => {
    const dir = initRepo();
    writeActiveSlot(dir);
    recordValidation({ checkoutDir: dir, harnessRoot: dir, status: 'pass', full: false });

    const result = await completeEnvironment({ repoPath: dir, agentId: 1, capture: true });

    expect(result.code).toBe(1);
    expect(mockedTeardown).not.toHaveBeenCalled();
  });

  it('re-runs full verify when verify is true', async () => {
    const dir = initRepo();
    writeActiveSlot(dir);
    fs.writeFileSync(path.join(dir, 'app.txt'), 'v2\n');

    const result = await completeEnvironment({
      repoPath: dir,
      agentId: 1,
      verify: true,
      capture: true,
    });

    expect(result.code).toBe(0);
    expect(mockedPlan).toHaveBeenCalled();
    expect(mockedTeardown).toHaveBeenCalledTimes(1);
    expect(result.stdout).not.toContain('Reused passing full validation');
  });

  it('attaches a reused validation to a bound work unit', async () => {
    const dir = initRepo();
    const attemptId = '00000000-0000-4000-8000-000000000324';
    upsertWorkUnit(dir, { workUnitId: '324', source: 'github' });
    createWorkAttempt(dir, { attemptId, workUnitId: '324', agentId: 1 });
    writeActiveSlot(dir, { workUnitId: '324', attemptId });
    const validation = recordValidation({
      checkoutDir: dir,
      harnessRoot: dir,
      status: 'pass',
      full: true,
      agentId: 1,
    });

    const result = await completeEnvironment({ repoPath: dir, agentId: 1, capture: true });

    expect(result.code).toBe(0);
    expect(findWorkUnit(dir, '324')?.outcome).toMatchObject({
      decision: 'completed',
      attemptId,
      validationId: validation.validationId,
      treeHash: validation.treeHash,
    });
  });
});
