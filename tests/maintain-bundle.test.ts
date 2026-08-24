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
    fs.unlinkSync(path.join(repoPath, '.har', 'launch.sh'));

    const drift = compareHarnessToTemplate(repoPath);
    const validation = validateHarness(repoPath);
    // #235: shims are not required files — deleting launch.sh keeps validation
    // green (the runtime lives in the package); drift still restores it.
    expect(validation.pass).toBe(true);

    const { bundleDir, report } = buildMaintainBundle(repoPath, validation, drift);

    expect(report.actions.some((a) => a.file === 'launch.sh' && a.kind === 'missing')).toBe(
      true,
    );
    expect(fs.existsSync(path.join(bundleDir, 'templates', 'launch.sh'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'drift-report.json'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'validation.json'))).toBe(true);
  });

  it('reports user edits as adapted (no action) — two-signal drift (#237)', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-maintain-drift-'));
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
    const launchPath = path.join(repoPath, '.har', 'launch.sh');
    fs.writeFileSync(launchPath, fs.readFileSync(launchPath, 'utf8') + '\n# drift marker\n');

    const drift = compareHarnessToTemplate(repoPath);
    const validation = validateHarness(repoPath);
    const { report } = buildMaintainBundle(repoPath, validation, drift);

    // User edited, template unchanged → informational, never a drift action.
    expect(report.actions.find((a) => a.file === 'launch.sh')).toBeUndefined();
    expect(report.adapted).toContain('launch.sh');
  });

  it('creates diffs for upstream-updated and conflict files — two-signal drift (#237)', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-maintain-upstream-'));
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });

    // Simulate "template moved since finalize" by rewinding the recorded
    // template baseline for launch.sh (upstream-updated) and verify.sh
    // (conflict: baseline rewound AND user edit).
    const manifestPath = path.join(repoPath, '.har', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.templateChecksums['launch.sh'] = '0000000000000000';
    manifest.templateChecksums['verify.sh'] = '0000000000000000';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const verifyPath = path.join(repoPath, '.har', 'verify.sh');
    fs.writeFileSync(verifyPath, fs.readFileSync(verifyPath, 'utf8') + '\n# local edit\n');

    const drift = compareHarnessToTemplate(repoPath);
    expect(drift.upstreamUpdated).toContain('launch.sh');
    expect(drift.conflict).toContain('verify.sh');

    const validation = validateHarness(repoPath);
    const { bundleDir, report } = buildMaintainBundle(repoPath, validation, drift);

    expect(report.actions.find((a) => a.file === 'launch.sh')?.kind).toBe('upstream-updated');
    expect(report.actions.find((a) => a.file === 'verify.sh')?.kind).toBe('conflict');
    expect(fs.existsSync(path.join(bundleDir, 'installed', 'launch.sh'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'templates', 'launch.sh'))).toBe(true);
    expect(fs.existsSync(path.join(bundleDir, 'diffs', 'verify.sh.diff'))).toBe(true);
    const diff = fs.readFileSync(path.join(bundleDir, 'diffs', 'verify.sh.diff'), 'utf8');
    expect(diff).toContain('local edit');
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

  it('maintainHarness builds bundle even when a required config file is missing', async () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-maintain-harness-'));
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
    // CLAUDE.agent.md is part of the required config surface (#235); shims are not.
    fs.unlinkSync(path.join(repoPath, '.har', 'CLAUDE.agent.md'));
    fs.unlinkSync(path.join(repoPath, '.har', 'launch.sh'));

    const result = await maintainHarness({ repoPath, finalize: false });

    expect(result.validation.pass).toBe(false);
    expect(result.bundle).toBeDefined();
    expect(fs.existsSync(path.join(repoPath, '.har', MAINTAIN_DIR, 'templates', 'launch.sh'))).toBe(
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
    // Platform upgrades are the migration registry now (#241), not prose.
    expect(maintainPrompt).toContain('migration registry');
    expect(maintainPrompt).toContain('MIGRATE-PROMPT.md');
    expect(maintainPrompt).not.toContain('Generator 0.5.0');
    expect(maintainPrompt).toContain('AGENTS.md');
  });

  it('maintain prompt includes dynamic drift actions from bundle report', () => {
    const initPrompt = buildInitAdaptationPrompt('/tmp/app', 'default');
    const maintainPrompt = buildMaintainAdaptationPrompt('/tmp/app', {
      generatedAt: '2026-07-09T12:00:00.000Z',
      profile: 'default',
      actions: [
        {
          file: 'launch.sh',
          kind: 'missing',
          template: 'maintain/templates/provision-toolchain.sh',
          hint: 'Add this file.',
        },
      ],
      adapted: [],
      pluginDrift: [],
      pluginActions: [],
      stale: [{ file: 'legacy.sh', hint: 'Delete after merge.' }],
      missingPortVars: ['HARNESS_DB_PORT_DEFAULT'],
      agentSlotMismatch: null,
      instructionFiles: [
        {
          kind: 'migrate_legacy_agent_md',
          path: 'AGENT.md',
          message: 'Legacy AGENT.md found — migrate into AGENTS.md.',
        },
      ],
      validation: {
        pass: false,
        errors: [{ file: 'launch.sh', message: 'Required file missing', severity: 'error' }],
        warnings: [],
      },
    });

    expect(maintainPrompt).not.toEqual(initPrompt);
    expect(maintainPrompt).toContain('launch.sh');
    expect(maintainPrompt).toContain('legacy.sh');
    expect(maintainPrompt).toContain('HARNESS_DB_PORT_DEFAULT');
    expect(maintainPrompt).toContain('Validation blockers');
    expect(maintainPrompt).toContain('Agent instruction files');
    expect(maintainPrompt).toContain('AGENT.md');
    expect(maintainPrompt).toContain('migration registry');
  });
});
