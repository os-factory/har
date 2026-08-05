import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  buildInitAdaptationPrompt,
  buildMaintainAdaptationPrompt,
} from '../src/harness/adaptation-prompt';
import { maintainHarness } from '../src/core/harness';
import { compareHarnessToTemplate } from '../src/harness/drift';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import {
  buildMaintainBundle,
  MAINTAIN_DIR,
  removeMaintainBundle,
} from '../src/harness/maintain-bundle';
import { validateHarness } from '../src/harness/validator';

describe('maintain bundle', () => {
  it('creates templates for missing required files', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-maintain-missing-'));
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
    fs.unlinkSync(path.join(repoPath, '.har', 'provision-toolchain.sh'));

    const drift = compareHarnessToTemplate(repoPath);
    const validation = validateHarness(repoPath);
    expect(validation.pass).toBe(false);

    const { bundleDir, report } = buildMaintainBundle(repoPath, validation, drift);

    expect(report.actions.some((a) => a.file === 'provision-toolchain.sh' && a.kind === 'missing')).toBe(
      true,
    );
    expect(fs.existsSync(path.join(bundleDir, 'templates', 'provision-toolchain.sh'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'drift-report.json'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'validation.json'))).toBe(true);
  });

  it('creates diffs for drifted files', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-maintain-drift-'));
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
    const launchPath = path.join(repoPath, '.har', 'launch.sh');
    fs.writeFileSync(launchPath, fs.readFileSync(launchPath, 'utf8') + '\n# drift marker\n');

    const drift = compareHarnessToTemplate(repoPath);
    const validation = validateHarness(repoPath);
    const { bundleDir, report } = buildMaintainBundle(repoPath, validation, drift);

    const launchAction = report.actions.find((a) => a.file === 'launch.sh');
    expect(launchAction?.kind).toBe('drift');
    expect(fs.existsSync(path.join(bundleDir, 'installed', 'launch.sh'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'templates', 'launch.sh'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'diffs', 'launch.sh.diff'))).toBe(true);
    const diff = fs.readFileSync(path.join(bundleDir, 'diffs', 'launch.sh.diff'), 'utf8');
    expect(diff).toContain('drift marker');
  });

  it('lists stale extra files', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-maintain-stale-'));
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
    fs.writeFileSync(path.join(repoPath, '.har', 'legacy-helper.sh'), '#!/bin/bash\necho legacy\n');

    const drift = compareHarnessToTemplate(repoPath);
    const validation = validateHarness(repoPath);
    const { bundleDir, report } = buildMaintainBundle(repoPath, validation, drift);

    expect(report.stale.some((s) => s.file === 'legacy-helper.sh')).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'stale', 'MANIFEST.md'))).toBe(true);
  });

  it('maintainHarness builds bundle even when validation fails', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-maintain-harness-'));
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
    fs.unlinkSync(path.join(repoPath, '.har', 'provision-toolchain.sh'));

    const result = await maintainHarness({ repoPath, finalize: false });

    expect(result.validation.pass).toBe(false);
    expect(result.bundle).toBeDefined();
    expect(fs.existsSync(path.join(repoPath, '.har', MAINTAIN_DIR, 'templates', 'provision-toolchain.sh'))).toBe(
      true,
    );
  });

  it('finalize removes the maintenance bundle', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-maintain-finalize-'));
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });

    await maintainHarness({ repoPath, finalize: false });
    expect(fs.existsSync(path.join(repoPath, '.har', MAINTAIN_DIR))).toBe(true);

    await maintainHarness({
      repoPath,
      finalize: true,
      summary: 'test finalize',
    });
    expect(fs.existsSync(path.join(repoPath, '.har', MAINTAIN_DIR))).toBe(false);
  });

  it('removeMaintainBundle deletes the directory', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-maintain-rm-'));
    fs.mkdirSync(path.join(repoPath, '.har', MAINTAIN_DIR), { recursive: true });
    fs.writeFileSync(path.join(repoPath, '.har', MAINTAIN_DIR, 'README.md'), 'temp');

    removeMaintainBundle(repoPath);
    expect(fs.existsSync(path.join(repoPath, '.har', MAINTAIN_DIR))).toBe(false);
  });
});

describe('adaptation prompts with maintain bundle', () => {
  it('maintain prompt references the maintenance bundle', () => {
    const maintainPrompt = buildMaintainAdaptationPrompt('/tmp/app');
    expect(maintainPrompt).toContain('.har/maintain/');
    expect(maintainPrompt).toContain('Do **not** read files from the globally installed har package');
    expect(maintainPrompt).not.toContain('{{MAINTAIN_BUNDLE_SECTION}}');
  });

  it('maintain prompt includes dynamic drift actions from bundle report', () => {
    const initPrompt = buildInitAdaptationPrompt('/tmp/app', 'default');
    const maintainPrompt = buildMaintainAdaptationPrompt('/tmp/app', {
      generatedAt: '2026-07-09T12:00:00.000Z',
      generatorVersion: { installed: '0.3.0', bundled: '0.6.0', outdated: true },
      profile: 'default',
      actions: [
        {
          file: 'provision-toolchain.sh',
          kind: 'missing',
          template: 'maintain/templates/provision-toolchain.sh',
          hint: 'Add this file.',
        },
      ],
      pluginDrift: [],
      pluginActions: [],
      stale: [{ file: 'legacy.sh', hint: 'Delete after merge.' }],
      missingPortVars: ['HARNESS_DB_PORT_DEFAULT'],
      agentSlotMismatch: null,
      validation: {
        pass: false,
        errors: [{ file: 'provision-toolchain.sh', message: 'Required file missing', severity: 'error' }],
        warnings: [],
      },
    });

    expect(maintainPrompt).not.toEqual(initPrompt);
    expect(maintainPrompt).toContain('provision-toolchain.sh');
    expect(maintainPrompt).toContain('legacy.sh');
    expect(maintainPrompt).toContain('HARNESS_DB_PORT_DEFAULT');
    expect(maintainPrompt).toContain('Validation blockers');
  });
});
