import * as fs from 'fs';
import * as path from 'path';
import { MANAGED_SHIM_FILES } from '../src/harness/template-tokens';

describe('harness lifecycle wrappers are absent (1.0 / #314)', () => {
  const harnesses = ['.har', 'control/.har', 'docs/.har'];

  it.each(harnesses.flatMap((h) => MANAGED_SHIM_FILES.map((s) => `${h}/${s}`)))(
    '%s is not present',
    (relPath) => {
      expect(fs.existsSync(path.join(__dirname, '..', relPath))).toBe(false);
    },
  );

  it.each(harnesses)('%s lifecycle stages dispatch by kind', (harness) => {
    const registry = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', harness, 'stages.json'), 'utf8'),
    );
    for (const stage of registry.stages) {
      if (['launch', 'verify', 'teardown', 'setup', 'inspect'].includes(stage.kind)) {
        expect(stage.command).toBeUndefined();
        expect(stage.script).toBeUndefined();
      }
    }
  });

  it.each(harnesses)('%s carries no vendored runtime machinery', (harness) => {
    for (const gone of ['agent-slot.sh', 'provision-toolchain.sh', 'simulator.sh']) {
      expect(fs.existsSync(path.join(__dirname, '..', harness, gone))).toBe(false);
    }
  });
});
