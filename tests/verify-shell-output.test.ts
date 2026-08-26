import * as fs from 'fs';
import * as path from 'path';

// The vendored bash verify pipeline (agent-slot.sh: run_step/record_step_result/
// escape_step_output) is retired — the packaged runtime is the single
// implementation (#234) and this repo's three harnesses are migrated (#242).
// The lifecycle entry points must be managed shims that forward to `har env`.

describe('harness lifecycle scripts are managed shims (1.0)', () => {
  const harnesses = ['.har', 'control/.har', 'docs/.har'];
  const shims = ['launch.sh', 'verify.sh', 'teardown.sh', 'setup-infra.sh', 'preflight.sh', 'agent-cli.sh'];

  it.each(harnesses.flatMap((h) => shims.map((s) => `${h}/${s}`)))(
    '%s forwards to har env with an npx fallback',
    (relPath) => {
      const script = fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
      expect(script).toContain('exec har env');
      expect(script).toContain('npx --yes @osfactory/har@');
      // No vendored pipeline internals survive in the shims.
      expect(script).not.toContain('record_step_result');
      expect(script).not.toContain('agent-slot.sh');
    },
  );

  it.each(harnesses)('%s carries no vendored runtime machinery', (harness) => {
    for (const gone of ['agent-slot.sh', 'provision-toolchain.sh', 'simulator.sh']) {
      expect(fs.existsSync(path.join(__dirname, '..', harness, gone))).toBe(false);
    }
  });
});
