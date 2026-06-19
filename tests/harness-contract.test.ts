import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { readStageRegistry } from '../src/harness/stages';
import { validateHarness } from '../src/harness/validator';
import { runStage } from '../src/core/run';

function makeTempRepo(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

describe('harness stage contract', () => {
  it('parses generic stage registry entries and runs a custom stage', async () => {
    const repoPath = makeTempRepo('har-stage');
    const stagesDir = path.join(repoPath, '.har', 'stages');
    fs.mkdirSync(stagesDir, { recursive: true });

    const scriptPath = path.join(stagesDir, 'custom.sh');
    fs.writeFileSync(
      scriptPath,
      [
        '#!/usr/bin/env bash',
        'set -euo pipefail',
        'echo "{\\"status\\":\\"pass\\",\\"urls\\":[{\\"url\\":\\"http://localhost:3000\\"}]}"',
      ].join('\n'),
    );
    fs.chmodSync(scriptPath, 0o755);

    fs.writeFileSync(
      path.join(repoPath, '.har', 'stages.json'),
      JSON.stringify(
        {
          version: '1',
          agentSlots: { min: 1, max: 5 },
          stages: [
            {
              id: 'custom-smoke',
              kind: 'custom',
              description: 'Custom project-owned smoke stage',
              command: './.har/stages/custom.sh {agentId}',
              artifacts: [{ path: '.har/artifacts/custom', kind: 'directory' }],
            },
          ],
        },
        null,
        2,
      ),
    );

    const registry = readStageRegistry(repoPath);
    expect(registry.stages[0]).toMatchObject({
      id: 'custom-smoke',
      kind: 'custom',
      command: './.har/stages/custom.sh {agentId}',
    });

    const result = await runStage({ repoPath, stageId: 'custom-smoke', agentId: 1 });
    expect(result).toMatchObject({
      status: 'pass',
      stageId: 'custom-smoke',
      kind: 'custom',
      code: 0,
    });
    expect(result.urls).toEqual([{ url: 'http://localhost:3000' }]);
  });

  it('scaffolds boilerplate with a valid stage registry in a fixture repo', () => {
    const repoPath = makeTempRepo('har-fixture');
    fs.cpSync(path.join(__dirname, 'fixtures', 'node-react-pg'), repoPath, { recursive: true });

    scaffoldHarnessBoilerplate(repoPath, { force: true });

    const validation = validateHarness(repoPath);
    expect(validation.pass).toBe(true);
    expect(validation.issues.some((issue) => issue.file === 'stages.json')).toBe(false);

    const registry = readStageRegistry(repoPath);
    expect(registry.stages.map((stage) => stage.id)).toEqual(
      expect.arrayContaining(['setup-infra', 'launch', 'verify', 'status', 'teardown']),
    );
    expect(registry.agentSlots).toEqual({ min: 1, max: 5 });
  });
});
