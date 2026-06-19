import * as path from 'path';
import {
  launchEnvironment,
  runVerification,
  teardownEnvironment,
  getEnvironmentStatus,
  getEnvironmentLogs,
  runStage,
  listArtifacts,
  computePreviewUrls,
} from '../src/core/run';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

describe('core run delegation', () => {
  it('delegates launch to .har/launch.sh', async () => {
    const result = await launchEnvironment({ repoPath: FIXTURE, agentId: 1, capture: true });
    expect(result.code).toBe(0);
    expect(result.previewUrls?.api).toBe('http://localhost:8010');
  });

  it('delegates verify to .har/verify.sh and parses JSON', async () => {
    const result = await runVerification({ repoPath: FIXTURE, agentId: 1, capture: true });
    expect(result.code).toBe(0);
    expect(result.verification?.status).toBe('pass');
    expect(result.verification?.agent_id).toBe(1);
  });

  it('delegates teardown and status to harness scripts', async () => {
    const teardown = await teardownEnvironment({ repoPath: FIXTURE, agentId: 1, capture: true });
    expect(teardown.code).toBe(0);

    const status = await getEnvironmentStatus({ repoPath: FIXTURE, agentId: 1, capture: true });
    expect(status.stdout).toContain('Agent 1');
  });

  it('delegates logs to agent-cli.sh', async () => {
    const logs = await getEnvironmentLogs({ repoPath: FIXTURE, agentId: 2 });
    expect(logs.stdout).toContain('log line');
  });

  it('runs a custom stage script from stages/', async () => {
    const result = await runStage({
      repoPath: FIXTURE,
      stageId: 'smoke',
      agentId: 1,
      capture: true,
    });
    expect(result.status).toBe('pass');
    expect(result.stageId).toBe('smoke');
  });

  it('lists artifacts under .har/artifacts', () => {
    const artifacts = listArtifacts({ repoPath: FIXTURE });
    expect(artifacts.some((a) => a.relativePath.includes('smoke/output.txt'))).toBe(true);
  });

  it('computes preview URLs from harness.env', () => {
    expect(computePreviewUrls(FIXTURE, 3)).toEqual({
      frontend: 'http://localhost:3030',
      api: 'http://localhost:8030',
      health: 'http://localhost:8030/health',
    });
  });
});
