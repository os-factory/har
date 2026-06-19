import * as path from 'path';
import { readStageRegistry, resolveStage, listStages, getVerificationStageIds, getAgentSlotRange } from '../src/harness/stages';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

describe('stage registry parsing', () => {
  it('loads stages.json from fixture harness', () => {
    const registry = readStageRegistry(FIXTURE);
    expect(registry?.version).toBe('1');
    expect(registry?.stages.some((s) => s.id === 'verify')).toBe(true);
  });

  it('resolves stage by id and kind', () => {
    expect(resolveStage(FIXTURE, { id: 'launch' })?.script).toBe('launch.sh');
    expect(resolveStage(FIXTURE, { kind: 'verify' })?.id).toBe('verify');
  });

  it('lists verification stage ids', () => {
    expect(getVerificationStageIds(FIXTURE)).toEqual(['smoke']);
    expect(listStages(FIXTURE).length).toBeGreaterThan(0);
  });

  it('reads agent slot range from stages.json', () => {
    expect(getAgentSlotRange(FIXTURE)).toEqual({ min: 1, max: 5 });
  });
});
