import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getAgentSlotRange } from '../src/harness/stages';
import { validateAgentId } from '../src/utils/validation';

describe('agent slot limits', () => {
  it('uses agentSlots from stages.json', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-slots-'));
    fs.mkdirSync(path.join(repoPath, '.har'), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, '.har', 'stages.json'),
      JSON.stringify({ version: '1', agentSlots: { min: 1, max: 12 }, stages: [] }),
    );

    expect(getAgentSlotRange(repoPath)).toEqual({ min: 1, max: 12 });
    expect(validateAgentId(12, repoPath)).toBe(12);
    expect(() => validateAgentId(13, repoPath)).toThrow('agent-id must be a number between 1 and 12');
  });

  it('falls back to harness.env when stages.json has no agentSlots', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-slots-env-'));
    fs.mkdirSync(path.join(repoPath, '.har'), { recursive: true });
    fs.writeFileSync(path.join(repoPath, '.har', 'stages.json'), JSON.stringify({ version: '1', stages: [] }));
    fs.writeFileSync(
      path.join(repoPath, '.har', 'harness.env'),
      ['export HARNESS_AGENT_SLOT_MIN=2', 'export HARNESS_AGENT_SLOT_MAX=8', ''].join('\n'),
    );

    expect(getAgentSlotRange(repoPath)).toEqual({ min: 2, max: 8 });
    expect(validateAgentId(2, repoPath)).toBe(2);
    expect(() => validateAgentId(1, repoPath)).toThrow('agent-id must be a number between 2 and 8');
  });
});
