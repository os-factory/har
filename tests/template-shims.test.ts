import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveTemplatesDir } from '../src/utils/paths';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { MANAGED_SHIM_FILES, RUNTIME_SHIM_FILES } from '../src/harness/template-tokens';

/**
 * #314: lifecycle wrappers are not generated. CLI and MCP are the only
 * entry points; stages dispatch by kind.
 */
describe('lifecycle wrappers are not generated (#314)', () => {
  const templates = resolveTemplatesDir();
  const kernel = path.join(templates, 'runtime-bundles', 'shared-kernel');
  const profiles = ['har-boilerplate', 'har-boilerplate-cli', 'har-boilerplate-ios'];

  it.each(profiles)('%s ships no runtime bash library', (profile) => {
    for (const gone of ['agent-slot.sh', 'simulator.sh', 'provision-toolchain.sh']) {
      expect(fs.existsSync(path.join(templates, profile, gone))).toBe(false);
    }
  });

  it.each(profiles)('%s carries no lifecycle wrappers', (profile) => {
    for (const shim of RUNTIME_SHIM_FILES) {
      expect(fs.existsSync(path.join(templates, profile, shim))).toBe(false);
    }
  });

  it('shared kernel carries no lifecycle wrappers or runtime bash', () => {
    expect(fs.existsSync(path.join(kernel, 'provision-toolchain.sh'))).toBe(false);
    expect(fs.existsSync(path.join(kernel, 'lib', 'infra.sh'))).toBe(false);
    expect(fs.existsSync(path.join(kernel, 'lib', 'node-pm.sh'))).toBe(false);
    expect(fs.existsSync(path.join(kernel, 'lib', 'verify-runner.mjs'))).toBe(true);
    for (const shim of RUNTIME_SHIM_FILES) {
      expect(fs.existsSync(path.join(kernel, shim))).toBe(false);
    }
  });

  it('pm2 bundle does not ship attach.sh', () => {
    expect(
      fs.existsSync(path.join(templates, 'runtime-bundles', 'pm2-runtime', 'attach.sh')),
    ).toBe(false);
  });

  it('scaffold writes no lifecycle wrappers for every profile', () => {
    for (const profile of ['default', 'cli', 'ios'] as const) {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), `har-shim-${profile}-`));
      try {
        scaffoldHarnessBoilerplate(repo, { profile });
        for (const shim of MANAGED_SHIM_FILES) {
          expect(fs.existsSync(path.join(repo, '.har', shim))).toBe(false);
        }
        const stages = JSON.parse(fs.readFileSync(path.join(repo, '.har', 'stages.json'), 'utf8'));
        for (const stage of stages.stages) {
          if (['launch', 'verify', 'teardown', 'setup', 'inspect'].includes(stage.kind)) {
            expect(stage.command).toBeUndefined();
            expect(stage.script).toBeUndefined();
          }
        }
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }
  });
});
