import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { runStage } from '../src/core/run-service';
import { getSlotRegistryPath } from '../src/core/slot-registry';
import { runStageArgs } from '../src/cli/commands/env';

/**
 * `har env run-stage <id> <stage> -- <args>` runs a project stage as verify
 * would for that slot: args reach the stage, cwd and WORK_DIR are the slot
 * work dir, the slot env file is loaded.
 */

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');
const PROBE = 'printf "%s|%s|%s|%s|%s\\n" "$WORK_DIR" "$AGENT_ID" "$PWD" "${SLOT_ONLY:-}" "$*"';

let repo: string;
let workDir: string;

beforeEach(() => {
  repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'har-run-stage-')));
  fs.cpSync(path.join(FIXTURE, '.har'), path.join(repo, '.har'), { recursive: true });
  for (const dir of ['runs', 'slots', 'work-units', 'work-attempts', 'validation-bindings']) {
    fs.rmSync(path.join(repo, '.har', dir), { recursive: true, force: true });
  }
  const stagesFile = path.join(repo, '.har', 'stages.json');
  const registry = JSON.parse(fs.readFileSync(stagesFile, 'utf8'));
  fs.writeFileSync(path.join(repo, '.har', 'stages', 'probe.sh'), `#!/usr/bin/env bash\n${PROBE}\n`, { mode: 0o755 });
  registry.stages.push(
    { id: 'probe-script', kind: 'custom', script: 'stages/probe.sh', requiresAgentId: true },
    { id: 'probe-command', kind: 'test', command: `bash -c '${PROBE.replace(/'/g, `'\\''`)}' probe`, requiresAgentId: true },
  );
  fs.writeFileSync(stagesFile, JSON.stringify(registry, null, 2));

  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'har-run-stage-wd-')));
  fs.writeFileSync(path.join(workDir, '.env.agent.1'), 'SLOT_ONLY="from-env-file"\nAPI_PORT=8010\n');
  const slotFile = getSlotRegistryPath(repo, 1);
  fs.mkdirSync(path.dirname(slotFile), { recursive: true });
  fs.writeFileSync(
    slotFile,
    JSON.stringify({
      version: 1,
      agentId: 1,
      projectName: 'minimal',
      mode: 'worktree',
      workDir,
      createdAt: new Date().toISOString(),
      status: 'active',
    }),
  );
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

function stdoutOf(result: Awaited<ReturnType<typeof runStage>>): string {
  return result.logs?.find((log) => log.stream === 'stdout')?.content ?? '';
}

describe('run-stage slot context', () => {
  it.each(['probe-script', 'probe-command'])('%s runs in the slot work dir with its env and the args', async (stageId) => {
    const result = await runStage({ repoPath: repo, stageId, agentId: 1, args: ['--grep', 'a b'], capture: true });
    expect(result.status).toBe('pass');
    // Script stages get the agent id first, as before.
    const args = stageId === 'probe-script' ? '1 --grep a b' : '--grep a b';
    expect(stdoutOf(result).trim()).toBe(`${workDir}|1|${workDir}|from-env-file|${args}`);
  });

  it('keeps the repo root when the slot has no work dir yet', async () => {
    fs.rmSync(getSlotRegistryPath(repo, 1));
    const result = await runStage({ repoPath: repo, stageId: 'probe-command', agentId: 1, capture: true });
    const [wd, , pwd] = stdoutOf(result).trim().split('|');
    expect(wd).toBe(process.env.WORK_DIR ?? '');
    expect(pwd).toBe(repo);
  });

  it('takes positionals and everything after -- as stage args, in order', () => {
    expect(runStageArgs({ args: ['a'], '--': ['--grep', 'x', 3] })).toEqual(['a', '--grep', 'x', '3']);
    expect(runStageArgs({})).toBeUndefined();
  });
});

describe('har env run-stage (built CLI)', () => {
  const cli = path.resolve(__dirname, '..', 'dist', 'index.js');
  const maybeIt = fs.existsSync(cli) ? it : it.skip;

  maybeIt('passes args after -- through, flags included', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'har-run-stage-home-'));
    try {
      const run = spawnSync(
        process.execPath,
        [cli, 'env', 'run-stage', '1', 'probe-command', '--repo', repo, '--', '--grep', 'login flow'],
        { cwd: repo, encoding: 'utf8', env: { ...process.env, HOME: home, HAR_TELEMETRY: '0' } },
      );
      expect(run.stderr).not.toMatch(/Unknown argument/);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain(`${workDir}|1|${workDir}|from-env-file|--grep login flow`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
