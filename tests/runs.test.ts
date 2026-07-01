import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildRunRelativePath,
  createRun,
  finishRun,
  getRun,
  listRuns,
  resolveAgentWorkDir,
} from '../src/core/runs';
import { compareHarnessToTemplate } from '../src/harness/drift';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { GENERATOR_VERSION } from '../src/harness/manifest';

describe('run storage layout', () => {
  it('buildRunRelativePath uses date folder and stage id filename', () => {
    const runsDir = path.join(os.tmpdir(), 'har-runs-test');
    const relative = buildRunRelativePath(
      'verify',
      1,
      new Date(2026, 5, 30, 17, 45, 32).toISOString(),
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      runsDir,
    );
    expect(relative).toBe('2026-06-30/17-45-32_verify_agent-1.json');
  });

  it('creates run under date subfolder and finds by runId', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-runs-create-'));
    fs.mkdirSync(path.join(repoPath, '.har'));
    fs.writeFileSync(
      path.join(repoPath, '.har', 'manifest.json'),
      JSON.stringify({ version: '1', generatorVersion: '0.3.0' }),
    );

    const run = createRun(
      { repoPath, trigger: 'cli' },
      { stageId: 'launch', kind: 'launch', agentId: 1, command: './.har/launch.sh 1' },
    );

    expect(run.relativePath).toMatch(/launch_agent-1\.json$/);
    expect(run.harnessRoot).toBe(repoPath);
    const runFile = path.join(repoPath, '.har', 'runs', run.relativePath!);
    expect(fs.existsSync(runFile)).toBe(true);

    finishRun(repoPath, run.runId, { status: 'pass', durationMs: 10 });
    const finished = getRun(repoPath, run.runId);
    expect(finished?.status).toBe('pass');
    expect(finished?.command).toBe('./.har/launch.sh 1');
  });

  it('listRuns reads nested date folders and legacy flat uuid files', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-runs-list-'));
    const runsDir = path.join(repoPath, '.har', 'runs');
    fs.mkdirSync(path.join(runsDir, '2026-06-28'), { recursive: true });

    const legacyId = '0e59472e-94cf-48b1-b7cf-ae7ab96674a3';
    fs.writeFileSync(
      path.join(runsDir, `${legacyId}.json`),
      JSON.stringify({
        runId: legacyId,
        repoPath,
        stageId: 'status',
        status: 'fail',
        startedAt: '2026-06-28T20:55:05.686Z',
        trigger: 'cli',
      }),
    );

    createRun({ repoPath, trigger: 'cli' }, { stageId: 'verify', agentId: 2 });

    const runs = listRuns(repoPath);
    expect(runs.length).toBe(2);
    expect(runs.some((r) => r.runId === legacyId)).toBe(true);
    expect(runs.some((r) => r.stageId === 'verify')).toBe(true);
  });

  it('resolveAgentWorkDir reads REPO_ROOT from env file', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-workdir-'));
    fs.mkdirSync(path.join(repoPath, '.har'), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, '.har', 'harness.env'),
      'export HARNESS_PROJECT_NAME=test_proj\n',
    );
    const workDir = path.join(os.tmpdir(), 'worktree-agent-1');
    fs.writeFileSync(
      path.join(repoPath, '.env.agent.1'),
      `AGENT_ID=1\nREPO_ROOT=${workDir}\n`,
    );

    expect(resolveAgentWorkDir(repoPath, 1)).toBe(workDir);
  });
});

describe('harness drift detection', () => {
  it('reports generator version and template drift after scaffold', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-drift-'));
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });

    const drift = compareHarnessToTemplate(repoPath);
    expect(drift.generatorVersion.bundled).toBe(GENERATOR_VERSION);
    expect(drift.missing).toEqual([]);
    expect(drift.extra).toEqual([]);
  });
});
