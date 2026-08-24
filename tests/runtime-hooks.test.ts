import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import {
  HOOK_CONTRACT_VERSION,
  LIFECYCLE_HOOKS,
  hookEnv,
  lifecycleHookPath,
  postHookFailureMode,
  runLifecycleHook,
} from '../src/runtime/hooks';
import { buildVerifyPlan } from '../src/runtime/verify';
import { teardownSession } from '../src/runtime/teardown';

function makeRepo(): { repo: string; harnessDir: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-hooks-'));
  const harnessDir = path.join(repo, '.har');
  fs.mkdirSync(path.join(harnessDir, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(harnessDir, 'harness.env'),
    'export HARNESS_PROJECT_NAME=hooks-fixture\n',
  );
  return { repo, harnessDir };
}

function writeHook(harnessDir: string, name: string, body: string): string {
  const file = path.join(harnessDir, 'hooks', `${name}.sh`);
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

describe('lifecycle hooks (#238)', () => {
  it('exposes the five sanctioned hook points', () => {
    expect([...LIFECYCLE_HOOKS]).toEqual([
      'pre-launch',
      'post-launch',
      'pre-verify',
      'pre-teardown',
      'post-teardown',
    ]);
  });

  it('does nothing when the hook file does not exist', () => {
    const { harnessDir } = makeRepo();
    const log = jest.fn();
    const result = runLifecycleHook('pre-launch', { harnessDir, agentId: 1, log });
    expect(result).toEqual({ ran: false, code: 0 });
    expect(log).not.toHaveBeenCalled();
  });

  it('hookEnv carries the versioned contract (AGENT_ID, WORK_DIR, ENV_FILE, ports)', () => {
    const { harnessDir } = makeRepo();
    const env = hookEnv('post-launch', {
      harnessDir,
      agentId: 3,
      workDir: '/tmp/wd',
      envFile: '/tmp/wd/.env.agent.3',
      ports: { frontend: 3030, api: 8030, 'minio-console': 19001 },
    });
    expect(env.HAR_HOOK).toBe('post-launch');
    expect(env.HAR_HOOK_CONTRACT).toBe(HOOK_CONTRACT_VERSION);
    expect(env.AGENT_ID).toBe('3');
    expect(env.HAR_HARNESS_DIR).toBe(harnessDir);
    expect(env.WORK_DIR).toBe('/tmp/wd');
    expect(env.ENV_FILE).toBe('/tmp/wd/.env.agent.3');
    expect(env.HAR_PORT_FRONTEND).toBe('3030');
    expect(env.HAR_PORT_API).toBe('8030');
    expect(env.HAR_PORT_MINIO_CONSOLE).toBe('19001');
  });

  it('runs an existing hook through bash and reports its exit code', () => {
    const { harnessDir } = makeRepo();
    const file = writeHook(harnessDir, 'pre-launch', 'exit 7');
    const log = jest.fn();
    const exec = jest.fn(() => ({ stdout: '', code: 7 }));
    const result = runLifecycleHook('pre-launch', { harnessDir, agentId: 1, exec, log });
    expect(result).toEqual({ ran: true, code: 7, file: '.har/hooks/pre-launch.sh' });
    expect(exec).toHaveBeenCalledWith(
      'bash',
      [file],
      expect.objectContaining({ env: expect.objectContaining({ HAR_HOOK: 'pre-launch' }) }),
    );
    expect(log).toHaveBeenCalledWith('Running .har/hooks/pre-launch.sh...');
  });

  it('executes for real (spawn path): env contract reaches the script', () => {
    const { repo, harnessDir } = makeRepo();
    const marker = path.join(repo, 'hook-ran.txt');
    writeHook(
      harnessDir,
      'post-teardown',
      `echo "$HAR_HOOK:$AGENT_ID:$HAR_HOOK_CONTRACT" > ${JSON.stringify(marker)}`,
    );
    const result = runLifecycleHook('post-teardown', { harnessDir, agentId: 4, workDir: repo });
    expect(result.code).toBe(0);
    expect(fs.readFileSync(marker, 'utf8').trim()).toBe(`post-teardown:4:${HOOK_CONTRACT_VERSION}`);
  });

  it('post-hook failure policy defaults to warn, opt-in fail', () => {
    expect(postHookFailureMode({})).toBe('warn');
    expect(postHookFailureMode({ HARNESS_HOOK_POST_FAILURE: 'warn' })).toBe('warn');
    expect(postHookFailureMode({ HARNESS_HOOK_POST_FAILURE: 'fail' })).toBe('fail');
  });

  it('lifecycleHookPath points into .har/hooks/', () => {
    const { harnessDir } = makeRepo();
    expect(lifecycleHookPath(harnessDir, 'pre-verify')).toBe(
      path.join(harnessDir, 'hooks', 'pre-verify.sh'),
    );
  });
});

describe('pre-verify hook in the verify plan (#238)', () => {
  function makeVerifyRepo(): { repo: string; harnessDir: string } {
    const { repo, harnessDir } = makeRepo();
    fs.writeFileSync(path.join(repo, '.env.agent.1'), 'AGENT_ID=1\n');
    // A stand-in stage runner so the plan can execute end-to-end in the test.
    fs.mkdirSync(path.join(harnessDir, 'lib'), { recursive: true });
    fs.writeFileSync(
      path.join(harnessDir, 'lib', 'verify-runner.mjs'),
      'console.log("RUNNER-RAN");\n',
    );
    return { repo, harnessDir };
  }

  it('plan exports ENV_FILE and guards the runner behind the hook', () => {
    const { repo } = makeVerifyRepo();
    const plan = buildVerifyPlan(repo, 1, [], process.env);
    expect(plan.shellCommand).toContain('hooks/pre-verify.sh');
    expect(plan.shellCommand).toContain('export ENV_FILE');
    expect(plan.shellCommand).toContain('ERROR: pre-verify hook failed');
  });

  it('a failing pre-verify hook aborts verify with its exit code', () => {
    const { repo, harnessDir } = makeVerifyRepo();
    writeHook(harnessDir, 'pre-verify', 'echo "hook says no" >&2; exit 9');
    const plan = buildVerifyPlan(repo, 1, [], process.env);
    let code = 0;
    let output = '';
    try {
      output = execSync(plan.shellCommand, {
        cwd: plan.cwd,
        shell: '/bin/bash',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      code = e.status ?? 1;
      output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    }
    expect(code).toBe(9);
    expect(output).toContain('pre-verify hook failed (exit 9)');
    expect(output).not.toContain('RUNNER-RAN');
  });

  it('a passing pre-verify hook lets the runner execute', () => {
    const { repo, harnessDir } = makeVerifyRepo();
    writeHook(harnessDir, 'pre-verify', 'true');
    const plan = buildVerifyPlan(repo, 1, [], process.env);
    const output = execSync(plan.shellCommand, {
      cwd: plan.cwd,
      shell: '/bin/bash',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(output).toContain('RUNNER-RAN');
  });
});

describe('teardown hooks (#238)', () => {
  it('a failing pre-teardown hook aborts teardown before any resource is touched', async () => {
    const { repo, harnessDir } = makeRepo();
    writeHook(harnessDir, 'pre-teardown', 'exit 3');
    const lines: string[] = [];
    const exec = jest.fn(() => ({ stdout: '', code: 3 }));
    const result = await teardownSession({
      repoPath: repo,
      agentId: 1,
      out: (m) => lines.push(m),
      exec,
    });
    expect(result.code).toBe(3);
    expect(lines.join('\n')).toContain('pre-teardown hook failed (exit 3)');
    expect(lines.join('\n')).not.toContain('torn down');
  });
});
