import {
  DescribeProjectOutputSchema,
  InitHarnessInputSchema,
  LaunchEnvironmentOutputSchema,
  RunStageInputSchema,
  RunVerificationOutputSchema,
  StageResultSchema,
  ListArtifactsOutputSchema,
} from '../src/mcp/schemas';

describe('MCP tool schemas', () => {
  it('validates describe project output', () => {
    const parsed = DescribeProjectOutputSchema.parse({
      repoPath: '/tmp/app',
      harnessPresent: true,
      manifest: {
        version: '1',
        generatorVersion: '0.2.0',
        outputDir: '.har',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        stack: { language: 'node' },
      },
      scripts: ['launch.sh'],
      stages: [{ id: 'launch', kind: 'launch', artifacts: [] }],
      verificationStages: ['smoke'],
      agentSlots: { min: 1, max: 5 },
      stackHints: { language: 'node' },
      harnessDrift: null,
    });
    expect(parsed.harnessPresent).toBe(true);
  });

  it('validates launch and verification outputs', () => {
    LaunchEnvironmentOutputSchema.parse({
      code: 0,
      stdout: '',
      stderr: '',
      previewUrls: { api: 'http://localhost:8010' },
    });

    RunVerificationOutputSchema.parse({
      code: 0,
      stdout: '{"status":"pass","agent_id":1,"stages":[]}',
      stderr: '',
      verification: { status: 'pass', agent_id: 1, stages: [] },
    });
  });

  it('validates run stage input and output', () => {
    RunStageInputSchema.parse({ repo: '.', stageId: 'verify', agentId: 1 });
    StageResultSchema.parse({
      status: 'pass',
      stageId: 'verify',
      code: 0,
      data: { agentId: 1 },
    });
  });

  it('validates artifact listing output', () => {
    ListArtifactsOutputSchema.parse({
      artifacts: [
        {
          path: '/tmp/.har/artifacts/out.json',
          relativePath: 'artifacts/out.json',
          sizeBytes: 10,
          modifiedAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
  });

  it('defaults init harness input profile to default', () => {
    const parsed = InitHarnessInputSchema.parse({ repo: '.' });
    expect(parsed.profile).toBe('default');
  });
});
