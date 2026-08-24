import * as fs from 'fs';
import * as path from 'path';
import { resolveTemplatesDir } from '../src/utils/paths';

/**
 * #234 acceptance: no business logic in generated files. Every runtime script
 * template is a thin delegate into `har env`, and the bash runtime library
 * files are gone from the template tree.
 */
describe('template runtime shims (#234)', () => {
  const templates = resolveTemplatesDir();
  const profiles = ['har-boilerplate', 'har-boilerplate-cli', 'har-boilerplate-ios'];
  const shims: Record<string, string[]> = {
    'har-boilerplate': ['launch.sh', 'teardown.sh', 'setup-infra.sh', 'verify.sh', 'agent-cli.sh', 'preflight.sh'],
    'har-boilerplate-cli': ['launch.sh', 'teardown.sh', 'setup-infra.sh', 'verify.sh', 'agent-cli.sh', 'preflight.sh'],
    'har-boilerplate-ios': ['launch.sh', 'teardown.sh', 'setup-infra.sh', 'verify.sh', 'agent-cli.sh'],
  };

  it.each(profiles)('%s ships no runtime bash library', (profile) => {
    for (const gone of ['agent-slot.sh', 'simulator.sh', 'provision-toolchain.sh']) {
      expect(fs.existsSync(path.join(templates, profile, gone))).toBe(false);
    }
  });

  it('shared kernel carries no provisioning or infra bash', () => {
    const kernel = path.join(templates, 'runtime-bundles', 'shared-kernel');
    expect(fs.existsSync(path.join(kernel, 'provision-toolchain.sh'))).toBe(false);
    expect(fs.existsSync(path.join(kernel, 'lib', 'infra.sh'))).toBe(false);
    expect(fs.existsSync(path.join(kernel, 'lib', 'node-pm.sh'))).toBe(false);
    expect(fs.existsSync(path.join(kernel, 'lib', 'verify-runner.mjs'))).toBe(true);
  });

  for (const profile of profiles) {
    it.each(shims[profile])(`${profile}/%s delegates to har env`, (shim) => {
      const file = path.join(templates, profile, shim);
      const content = fs.readFileSync(file, 'utf8');
      expect(content).toContain('exec har env');
      expect(content).toContain('node_modules/.bin/har');
      expect(content).not.toContain('node -e');
      expect(content.split('\n').length).toBeLessThanOrEqual(25);
    });
  }

  it('pm2 attach.sh delegates to har env agent attach', () => {
    const content = fs.readFileSync(
      path.join(templates, 'runtime-bundles', 'pm2-runtime', 'attach.sh'),
      'utf8',
    );
    expect(content).toContain('har env agent "$AGENT_ID" attach');
    expect(content).not.toContain('node -e');
  });
});
