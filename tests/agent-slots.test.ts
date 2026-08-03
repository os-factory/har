import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectAgentSlotEnvMismatch,
  getAgentSlotRange,
  syncAgentSlotsToHarnessEnv,
} from '../src/harness/stages';
import { formatInvalidAgentIdError, validateAgentId } from '../src/utils/validation';
import { compareHarnessToTemplate } from '../src/harness/drift';

describe('agent slot limits', () => {
  it('formatInvalidAgentIdError explains out-of-range slots', () => {
    const msg = formatInvalidAgentIdError(4, { min: 1, max: 3 });
    expect(msg).toContain('Invalid agent slot id: 4');
    expect(msg).toContain('Valid slots: 1–3');
    expect(msg).toContain('agentSlots');
    expect(msg).toContain('har env status');
    expect(msg).toContain('raise agentSlots.max');
  });

  it('uses agentSlots from stages.json', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-slots-'));
    fs.mkdirSync(path.join(repoPath, '.har'), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, '.har', 'stages.json'),
      JSON.stringify({ version: '1', agentSlots: { min: 1, max: 12 }, stages: [] }),
    );

    expect(getAgentSlotRange(repoPath)).toEqual({ min: 1, max: 12 });
    expect(validateAgentId(12, repoPath)).toBe(12);
    expect(() => validateAgentId(13, repoPath)).toThrow(
      formatInvalidAgentIdError(13, { min: 1, max: 12 }),
    );
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
    expect(() => validateAgentId(1, repoPath)).toThrow(
      formatInvalidAgentIdError(1, { min: 2, max: 8 }),
    );
  });

  it('detects mismatch between stages.json and harness.env', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-slots-mismatch-'));
    fs.mkdirSync(path.join(repoPath, '.har'), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, '.har', 'stages.json'),
      JSON.stringify({ version: '1', agentSlots: { min: 1, max: 10 }, stages: [] }),
    );
    fs.writeFileSync(
      path.join(repoPath, '.har', 'harness.env'),
      ['export HARNESS_AGENT_SLOT_MIN=1', 'export HARNESS_AGENT_SLOT_MAX=3', ''].join('\n'),
    );

    expect(detectAgentSlotEnvMismatch(repoPath)).toEqual({
      stages: { min: 1, max: 10 },
      env: { min: 1, max: 3 },
    });
    expect(compareHarnessToTemplate(repoPath).agentSlotMismatch).toEqual({
      stages: { min: 1, max: 10 },
      env: { min: 1, max: 3 },
    });
  });

  it('syncs harness.env slot limits from stages.json', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-slots-sync-'));
    fs.mkdirSync(path.join(repoPath, '.har'), { recursive: true });
    fs.writeFileSync(
      path.join(repoPath, '.har', 'stages.json'),
      JSON.stringify({ version: '1', agentSlots: { min: 1, max: 10 }, stages: [] }),
    );
    fs.writeFileSync(
      path.join(repoPath, '.har', 'harness.env'),
      ['export HARNESS_AGENT_SLOT_MIN=1', 'export HARNESS_AGENT_SLOT_MAX=3', ''].join('\n'),
    );

    expect(syncAgentSlotsToHarnessEnv(repoPath)).toBe(true);
    expect(detectAgentSlotEnvMismatch(repoPath)).toBeNull();
    const env = fs.readFileSync(path.join(repoPath, '.har', 'harness.env'), 'utf8');
    expect(env).toContain('export HARNESS_AGENT_SLOT_MAX=10');
  });
});
