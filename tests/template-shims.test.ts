import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveTemplatesDir } from '../src/utils/paths';
import { getHarPackageVersion } from '../src/core/package-version';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { RUNTIME_SHIM_FILES, substituteTemplateTokens } from '../src/harness/template-tokens';

/**
 * #234 acceptance: no business logic in generated files. Every runtime script
 * template is a thin delegate into `har env`, and the bash runtime library
 * files are gone from the template tree.
 *
 * #235: one shared shim set (runtime-bundles/shared-kernel) serves every
 * profile, with a pinned `npx @osfactory/har@<version>` fallback rendered at
 * generation time and a clear error when neither har nor node is available.
 */
describe('template runtime shims (#234/#235)', () => {
  const templates = resolveTemplatesDir();
  const kernel = path.join(templates, 'runtime-bundles', 'shared-kernel');
  const profiles = ['har-boilerplate', 'har-boilerplate-cli', 'har-boilerplate-ios'];

  it.each(profiles)('%s ships no runtime bash library', (profile) => {
    for (const gone of ['agent-slot.sh', 'simulator.sh', 'provision-toolchain.sh']) {
      expect(fs.existsSync(path.join(templates, profile, gone))).toBe(false);
    }
  });

  it.each(profiles)('%s carries no per-profile shim copies (shared set only)', (profile) => {
    for (const shim of RUNTIME_SHIM_FILES) {
      expect(fs.existsSync(path.join(templates, profile, shim))).toBe(false);
    }
  });

  it('shared kernel carries no provisioning or infra bash', () => {
    expect(fs.existsSync(path.join(kernel, 'provision-toolchain.sh'))).toBe(false);
    expect(fs.existsSync(path.join(kernel, 'lib', 'infra.sh'))).toBe(false);
    expect(fs.existsSync(path.join(kernel, 'lib', 'node-pm.sh'))).toBe(false);
    expect(fs.existsSync(path.join(kernel, 'lib', 'verify-runner.mjs'))).toBe(true);
  });

  it.each([...RUNTIME_SHIM_FILES])('shared-kernel/%s delegates to har env with pinned npx fallback', (shim) => {
    const content = fs.readFileSync(path.join(kernel, shim), 'utf8');
    expect(content).toContain('exec har env');
    expect(content).toContain('node_modules/.bin/har');
    expect(content).toContain('npx --yes @osfactory/har@__HAR_VERSION__');
    expect(content).toContain('exit 127');
    // Clear error when neither har nor node is available.
    expect(content).toMatch(/Error: cannot run the HAR runtime/);
    expect(content).not.toContain('node -e');
    expect(content.split('\n').length).toBeLessThanOrEqual(25);
  });

  it('verify.sh keeps its JSON stdout contract', () => {
    const content = fs.readFileSync(path.join(kernel, 'verify.sh'), 'utf8');
    for (const line of content.split('\n')) {
      if (line.trim().startsWith('exec ')) expect(line).toContain('--json');
    }
  });

  it('substituteTemplateTokens renders the pinned package version', () => {
    const rendered = substituteTemplateTokens('npx --yes @osfactory/har@__HAR_VERSION__ env verify', 'proj');
    expect(rendered).toBe(`npx --yes @osfactory/har@${getHarPackageVersion()} env verify`);
  });

  it('scaffold renders shims with the pinned version for every profile', () => {
    for (const profile of ['default', 'cli', 'ios'] as const) {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), `har-shim-${profile}-`));
      try {
        scaffoldHarnessBoilerplate(repo, { profile });
        for (const shim of RUNTIME_SHIM_FILES) {
          const file = path.join(repo, '.har', shim);
          expect(fs.existsSync(file)).toBe(true);
          const content = fs.readFileSync(file, 'utf8');
          expect(content).toContain(`npx --yes @osfactory/har@${getHarPackageVersion()}`);
          expect(content).not.toContain('__HAR_VERSION__');
        }
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    }
  });

  it('pm2 attach.sh delegates to har env agent attach', () => {
    const content = fs.readFileSync(
      path.join(templates, 'runtime-bundles', 'pm2-runtime', 'attach.sh'),
      'utf8',
    );
    expect(content).toContain('har env agent "$AGENT_ID" attach');
    expect(content).not.toContain('node -e');
  });
});
