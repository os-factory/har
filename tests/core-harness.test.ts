import * as path from 'path';
import { describeProject } from '../src/core/harness';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

describe('describeProject', () => {
  it('returns manifest, scripts, and stages for fixture repo', () => {
    const description = describeProject(FIXTURE);
    expect(description.harnessPresent).toBe(true);
    expect(description.manifest?.stack?.language).toBe('node');
    expect(description.scripts).toContain('launch.sh');
    expect(description.stages.some((s) => s.id === 'verify')).toBe(true);
    expect(description.verificationStages).toEqual(['smoke']);
    expect(description.agentSlots).toEqual({ min: 1, max: 5 });
    expect(description.harnessDrift).not.toBeNull();
  });
});
