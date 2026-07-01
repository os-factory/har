import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectEnvironmentStatus } from '../src/core/slot-status';
import { createRun } from '../src/core/runs';

describe('slot status', () => {
  it('collectEnvironmentStatus returns slots for configured range', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-slot-status-'));
    const harDir = path.join(repoPath, '.har');
    fs.mkdirSync(harDir, { recursive: true });
    fs.writeFileSync(
      path.join(harDir, 'manifest.json'),
      JSON.stringify({ version: '1', generatorVersion: '0.1.0', profile: 'cli' }),
    );
    fs.writeFileSync(
      path.join(harDir, 'stages.json'),
      JSON.stringify({
        version: '1',
        agentSlots: { min: 1, max: 2 },
        stages: [],
      }),
    );
    fs.writeFileSync(
      path.join(harDir, 'harness.env'),
      'export HARNESS_PROJECT_NAME="test-project"\nexport HARNESS_AGENT_SLOT_MIN=1\nexport HARNESS_AGENT_SLOT_MAX=2\n',
    );

    createRun({ repoPath, trigger: 'mcp' }, { stageId: 'verify', agentId: 1 });

    const status = collectEnvironmentStatus(repoPath);
    expect(status.slots.length).toBe(2);
    expect(status.slots[0].agentId).toBe(1);
    expect(status.slots[0].harnessUsage).toBe('mcp');
  });
});
