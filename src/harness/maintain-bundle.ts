import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileSafe } from '../utils/file-ops';
import { run } from '../utils/shell';
import type { HarnessProfile } from './generator';
import type { HarnessDriftResult } from './drift';
import { templateFileForHarness } from './gitignore-template';
import { getHarnessDir, readManifest } from './manifest';
import {
  buildPluginDriftActions,
  compareInstalledPluginsToTemplate,
  readInstalledPluginFile,
  readTemplatePluginFile,
  type PluginDriftAction,
  type PluginDriftResult,
} from './plugin-drift';
import { composeProfileTemplateMap, readComposedTemplateContent } from './profiles';
import { substituteTemplateTokens } from './template-tokens';
import type { ValidationIssue, ValidationResult } from './validator';
import { detectInstructionFiles } from './instruction-files';

export const MAINTAIN_DIR = 'maintain';

export type MaintainActionKind = 'missing' | 'upstream-updated' | 'conflict';

export interface MaintainAction {
  file: string;
  kind: MaintainActionKind;
  template: string;
  installed?: string;
  diff?: string;
  hint: string;
}

export interface MaintainStaleFile {
  file: string;
  hint: string;
}

/** Repo-root agent instruction migrations (outside `.har/` checksum drift). */
export interface InstructionFileMaintainNote {
  kind:
    | 'migrate_legacy_agent_md'
    | 'create_agents_md'
    | 'refresh_agents_md_har_section'
    | 'claude_md_pointer';
  path: string;
  message: string;
}

export interface MaintainBundleReport {
  generatedAt: string;
  profile: HarnessProfile;
  actions: MaintainAction[];
  /** User-adapted files that are current with upstream — informational, no action needed. */
  adapted: string[];
  pluginDrift: PluginDriftResult[];
  pluginActions: PluginDriftAction[];
  stale: MaintainStaleFile[];
  missingPortVars: string[];
  agentSlotMismatch: HarnessDriftResult['agentSlotMismatch'];
  /** Generator 0.5.0+ — AGENTS.md / CLAUDE.md guidance for the adapt prompt. */
  instructionFiles: InstructionFileMaintainNote[];
  validation: {
    pass: boolean;
    errors: ValidationIssue[];
    warnings: ValidationIssue[];
  };
}

export interface MaintainBundleResult {
  bundleDir: string;
  report: MaintainBundleReport;
}

const substituteProjectName = substituteTemplateTokens;

function projectNameFromRepo(repoPath: string): string {
  return path.basename(repoPath).toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function readBundledTemplateContent(
  repoPath: string,
  profile: HarnessProfile,
  file: string,
): string {
  // Resolve through the composed bundle set — bundle-provided files (e.g.
  // provision-toolchain.sh) no longer exist in the profile overlay dirs.
  const entry = composeProfileTemplateMap(profile).get(templateFileForHarness(file));
  if (!entry) {
    throw new Error(`Template file not found in composed ${profile} profile: ${file}`);
  }
  let content = readComposedTemplateContent(entry);
  if (file === 'harness.env') {
    content = substituteProjectName(content, projectNameFromRepo(repoPath));
  }
  return content;
}

function staleFileHint(file: string): string {
  if (file.endsWith('.sh')) {
    return 'Legacy harness script — merge behavior into current templates, then delete.';
  }
  if (file.endsWith('.local') || file.includes('.env')) {
    return 'Local override — move needed values into harness.env or delete if obsolete.';
  }
  return 'Not in the current bundled template — review, merge, or delete.';
}

function actionHint(file: string, kind: MaintainActionKind): string {
  if (kind === 'missing') {
    if (file === 'provision-toolchain.sh') {
      return 'Add this file and ensure launch.sh calls it to provision the toolchain.';
    }
    return `Copy/adapt from maintain/templates/${file} into .har/${file}.`;
  }
  if (kind === 'conflict') {
    return `Upstream template AND your local edits both changed — read maintain/diffs/${file}.diff and merge carefully; keep repo-specific customizations.`;
  }
  if (file === 'harness.env') {
    return 'Upstream template updated; merge changes — keep repo-specific values and add any missing port vars.';
  }
  return `Upstream template updated since your last finalize — read maintain/diffs/${file}.diff and apply into .har/${file}.`;
}

function createUnifiedDiff(
  installedContent: string,
  templateContent: string,
  installedLabel: string,
  templateLabel: string,
): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-maintain-diff-'));
  try {
    const installedPath = path.join(tmpDir, 'installed');
    const templatePath = path.join(tmpDir, 'template');
    fs.writeFileSync(installedPath, installedContent);
    fs.writeFileSync(templatePath, templateContent);
    const result = run(`diff -u "${installedPath}" "${templatePath}"`);
    const body = result.stdout.trim();
    if (!body) return '';
    return `--- ${installedLabel}\n+++ ${templateLabel}\n${body.split('\n').slice(2).join('\n')}\n`;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function buildActions(
  repoPath: string,
  profile: HarnessProfile,
  drift: HarnessDriftResult,
): MaintainAction[] {
  const harnessDir = getHarnessDir(repoPath);
  const actions: MaintainAction[] = [];

  for (const file of drift.missing) {
    actions.push({
      file,
      kind: 'missing',
      template: `maintain/templates/${file}`,
      hint: actionHint(file, 'missing'),
    });
  }

  const upstreamAffected: Array<[string, MaintainActionKind]> = [
    ...drift.upstreamUpdated.map((f): [string, MaintainActionKind] => [f, 'upstream-updated']),
    ...drift.conflict.map((f): [string, MaintainActionKind] => [f, 'conflict']),
  ];
  for (const [file, kind] of upstreamAffected) {
    const installedPath = path.join(harnessDir, file);

    actions.push({
      file,
      kind,
      template: `maintain/templates/${file}`,
      installed: fs.existsSync(installedPath) ? `maintain/installed/${file}` : undefined,
      diff: `maintain/diffs/${file}.diff`,
      hint: actionHint(file, kind),
    });
  }

  return actions.sort((a, b) => a.file.localeCompare(b.file));
}

function buildStale(drift: HarnessDriftResult): MaintainStaleFile[] {
  return drift.extra
    .map((file) => ({ file, hint: staleFileHint(file) }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

export function buildInstructionFileNotes(repoPath: string): InstructionFileMaintainNote[] {
  const detection = detectInstructionFiles(repoPath);
  const notes: InstructionFileMaintainNote[] = [];

  if (detection.agentMd) {
    notes.push({
      kind: 'migrate_legacy_agent_md',
      path: 'AGENT.md',
      message:
        'Legacy AGENT.md (singular) found — merge unique notes into AGENTS.md, then delete AGENT.md. Codex auto-loads AGENTS.md only.',
    });
  }

  if (!detection.agentsMd) {
    notes.push({
      kind: 'create_agents_md',
      path: 'AGENTS.md',
      message:
        'AGENTS.md missing — create it with a HAR / agent environment section (or let maintain’s instruction-files step scaffold it, then fill project-specific notes).',
    });
  } else {
    notes.push({
      kind: 'refresh_agents_md_har_section',
      path: 'AGENTS.md',
      message:
        'Refresh the managed HAR / agent environment section in AGENTS.md if workflow/commands changed — do not wipe unrelated project guidance.',
    });
  }

  if (detection.claudeMd) {
    notes.push({
      kind: 'claude_md_pointer',
      path: 'CLAUDE.md',
      message:
        'Keep CLAUDE.md as a thin pointer to AGENTS.md (do not duplicate the full HAR workflow).',
    });
  } else {
    notes.push({
      kind: 'claude_md_pointer',
      path: 'CLAUDE.md',
      message:
        'Optional: add a thin CLAUDE.md pointer → AGENTS.md when Claude Code is used on this repo.',
    });
  }

  return notes;
}

function buildReadme(report: MaintainBundleReport): string {
  const lines: string[] = [
    '# Harness maintenance bundle',
    '',
    `Generated by \`har env maintain\` on ${report.generatedAt}.`,
    `Profile: ${report.profile}`,
    '',
    'Reference templates and diffs live in this directory. Edit live files in `.har/` — not `maintain/templates/` directly.',
    '',
    '## Validation (fix before `--finalize`)',
    '',
  ];

  if (report.validation.errors.length === 0 && report.validation.warnings.length === 0) {
    lines.push('- All structural checks passed.');
  } else {
    for (const issue of report.validation.errors) {
      lines.push(`- ✗ **${issue.file}**: ${issue.message}`);
    }
    for (const issue of report.validation.warnings) {
      lines.push(`- ⚠ **${issue.file}**: ${issue.message}`);
    }
  }

  lines.push(
    '',
    '## Drift actions',
    '',
    'Drift is two signals: **user-edited** (your file changed since the last finalize) and',
    '**upstream-updated** (the bundled template changed since the last finalize). Only',
    '`upstream-updated` and `conflict` (both signals) need action — files you adapted and',
    'finalized are *not* drift.',
    '',
  );

  if (report.actions.length === 0) {
    lines.push('No missing files and no upstream template updates.');
  } else {
    lines.push('| File | Status | Reference |');
    lines.push('|------|--------|-----------|');
    for (const action of report.actions) {
      const ref =
        action.kind === 'missing'
          ? `templates/${action.file}`
          : `diffs/${action.file}.diff`;
      lines.push(`| ${action.file} | ${action.kind} | ${ref} |`);
    }
  }

  if (report.adapted.length > 0) {
    lines.push(
      '',
      '### Adapted files (current with upstream — no action)',
      '',
      ...report.adapted.map((f) => `- \`${f}\``),
      '',
      'These carry local edits since the last finalize. Run `har env maintain --finalize` to bless them as the new baseline.',
    );
  }

  lines.push('', '## Plugin drift (installed verification plugins)', '');

  if (report.pluginActions.length === 0) {
    lines.push('No installed plugins detected, or all plugin files match bundled templates.');
  } else {
    lines.push('| Plugin | File | Status | Reference |');
    lines.push('|--------|------|--------|-----------|');
    for (const action of report.pluginActions) {
      const ref =
        action.kind === 'missing'
          ? `plugins/${action.pluginId}/templates/${action.file}`
          : `plugins/${action.pluginId}/diffs/${action.file}.diff`;
      lines.push(`| ${action.pluginId} | ${action.file} | ${action.kind} | ${ref} |`);
    }
    lines.push(
      '',
      'To refresh all plugin files: `har env add-plugin <id> --force` (overwrites plugin-owned paths).',
      '',
    );
  }

  if (report.missingPortVars.length > 0) {
    lines.push('', '## Missing port vars in harness.env', '');
    for (const v of report.missingPortVars) {
      lines.push(`- \`${v}\` — copy from \`maintain/templates/harness.env\``);
    }
  }

  if (report.agentSlotMismatch) {
    lines.push(
      '',
      '## Agent slot limit mismatch',
      '',
      `- \`stages.json\` agentSlots: ${report.agentSlotMismatch.stages.min}–${report.agentSlotMismatch.stages.max}`,
      `- \`harness.env\` HARNESS_AGENT_SLOT_*: ${report.agentSlotMismatch.env.min}–${report.agentSlotMismatch.env.max}`,
      '',
      'Canonical source is `.har/stages.json`. Run `har env maintain` to sync legacy exports in `harness.env`, or edit `agentSlots` there.',
      '',
    );
  }

  if (report.instructionFiles.length > 0) {
    lines.push('', '## Agent instruction files (generator 0.5.0)', '');
    lines.push(
      'Repo-root agent docs are **outside** `.har/` checksum drift. Apply while adapting:',
      '',
      '**Merge contract:** `har env maintain --finalize` refreshes only the content between',
      '`<!-- har:agent-environment:start/end -->` in `AGENTS.md`. Custom `## Project` sections and',
      'other guidance **outside** those markers must survive finalize — relocate them if needed.',
      '',
    );
    for (const note of report.instructionFiles) {
      lines.push(`- **\`${note.path}\`** (${note.kind}): ${note.message}`);
    }
  }

  lines.push('', '## Stale files (review)', '');

  if (report.stale.length === 0) {
    lines.push('None detected.');
  } else {
    for (const stale of report.stale) {
      lines.push(`- **${stale.file}** — ${stale.hint}`);
    }
  }

  lines.push(
    '',
    '## Next steps',
    '',
    '1. Resolve each harness drift action (merge diffs; keep repo-specific customizations).',
    '2. Merge plugin drift under `maintain/plugins/` or run `har env add-plugin <id> --force`.',
    '3. Review stale files — delete or merge superseded scripts.',
    '4. Re-run `har env maintain` until validation passes and drift is clear.',
    '5. `har env maintain --finalize --summary "<what changed>"`',
    '',
  );

  return lines.join('\n');
}

function writeBundleArtifacts(
  repoPath: string,
  profile: HarnessProfile,
  drift: HarnessDriftResult,
  report: MaintainBundleReport,
): string {
  const harnessDir = getHarnessDir(repoPath);
  const bundleDir = path.join(harnessDir, MAINTAIN_DIR);

  if (fs.existsSync(bundleDir)) {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }

  const dirs = [
    bundleDir,
    path.join(bundleDir, 'templates'),
    path.join(bundleDir, 'installed'),
    path.join(bundleDir, 'diffs'),
    path.join(bundleDir, 'stale'),
  ];
  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const affectedFiles = [...drift.missing, ...drift.upstreamUpdated, ...drift.conflict];
  for (const file of affectedFiles) {
    const templateContent = readBundledTemplateContent(repoPath, profile, file);
    writeFileSafe(path.join(bundleDir, 'templates', file), templateContent);

    const harnessPath = path.join(harnessDir, file);
    if (fs.existsSync(harnessPath)) {
      const installedContent = fs.readFileSync(harnessPath, 'utf8');
      writeFileSafe(path.join(bundleDir, 'installed', file), installedContent);
      const diff = createUnifiedDiff(
        installedContent,
        templateContent,
        `installed/${file}`,
        `templates/${file}`,
      );
      if (diff) {
        writeFileSafe(path.join(bundleDir, 'diffs', `${file}.diff`), diff);
      }
    }
  }

  writeFileSafe(path.join(bundleDir, 'README.md'), buildReadme(report));
  writeFileSafe(path.join(bundleDir, 'drift-report.json'), JSON.stringify(report, null, 2) + '\n');
  writeFileSafe(
    path.join(bundleDir, 'validation.json'),
    JSON.stringify(report.validation, null, 2) + '\n',
  );

  if (report.stale.length > 0) {
    const staleLines = [
      '# Stale harness files',
      '',
      'These files exist in `.har/` but are not part of the current bundled template.',
      '',
      ...report.stale.map((s) => `- **${s.file}** — ${s.hint}`),
      '',
    ];
    writeFileSafe(path.join(bundleDir, 'stale', 'MANIFEST.md'), staleLines.join('\n'));
  }

  return bundleDir;
}

function ensureParentDir(filePath: string): void {
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
}

function writePluginBundleArtifacts(repoPath: string, bundleDir: string, report: MaintainBundleReport): void {
  if (report.pluginActions.length === 0) return;

  for (const action of report.pluginActions) {
    const pluginRoot = path.join(bundleDir, 'plugins', action.pluginId);
    const templatesDir = path.join(pluginRoot, 'templates');
    const installedDir = path.join(pluginRoot, 'installed');
    const diffsDir = path.join(pluginRoot, 'diffs');
    for (const dir of [templatesDir, installedDir, diffsDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const templateContent = readTemplatePluginFile(action.pluginId, action.file);
    if (templateContent === null) continue;

    const templatePath = path.join(templatesDir, action.file);
    ensureParentDir(templatePath);
    writeFileSafe(templatePath, templateContent);

    const installedContent = readInstalledPluginFile(repoPath, action.pluginId, action.file);
    if (installedContent !== null) {
      const installedPath = path.join(installedDir, action.file);
      ensureParentDir(installedPath);
      writeFileSafe(installedPath, installedContent);
      const diff = createUnifiedDiff(
        installedContent,
        templateContent,
        `installed/${action.file}`,
        `templates/${action.file}`,
      );
      if (diff) {
        const diffPath = path.join(diffsDir, `${action.file}.diff`);
        ensureParentDir(diffPath);
        writeFileSafe(diffPath, diff);
      }
    }
  }
}

export function buildMaintainBundle(
  repoPath: string,
  validation: ValidationResult,
  drift: HarnessDriftResult,
): MaintainBundleResult {
  const manifest = readManifest(repoPath);
  const profile: HarnessProfile = manifest?.profile ?? 'default';
  const errors = validation.issues.filter((i) => i.severity === 'error');
  const warnings = validation.issues.filter((i) => i.severity === 'warning');
  const pluginDrift = compareInstalledPluginsToTemplate(repoPath);
  const pluginActions = buildPluginDriftActions(repoPath, pluginDrift);

  const report: MaintainBundleReport = {
    generatedAt: new Date().toISOString(),
    profile,
    actions: buildActions(repoPath, profile, drift),
    adapted: [...drift.userAdapted].sort((a, b) => a.localeCompare(b)),
    pluginDrift,
    pluginActions,
    stale: buildStale(drift),
    missingPortVars: drift.missingPortVars,
    agentSlotMismatch: drift.agentSlotMismatch,
    instructionFiles: buildInstructionFileNotes(repoPath),
    validation: {
      pass: validation.pass,
      errors,
      warnings,
    },
  };

  const bundleDir = writeBundleArtifacts(repoPath, profile, drift, report);
  writePluginBundleArtifacts(repoPath, bundleDir, report);
  return { bundleDir, report };
}

export function removeMaintainBundle(repoPath: string): void {
  const bundleDir = path.join(getHarnessDir(repoPath), MAINTAIN_DIR);
  if (fs.existsSync(bundleDir)) {
    fs.rmSync(bundleDir, { recursive: true, force: true });
  }
}

export function formatMaintainBundlePromptSection(report: MaintainBundleReport): string {
  const lines: string[] = [
    '## Step 0 — Read the maintenance bundle',
    '',
    'Open `.har/maintain/README.md` and `.har/maintain/drift-report.json`.',
    'Harness reference templates: `.har/maintain/templates/`.',
    'Plugin reference templates: `.har/maintain/plugins/<plugin-id>/`.',
    'Do **not** read files from the globally installed har package.',
    '',
  ];

  if (report.validation.errors.length > 0) {
    lines.push('### Validation blockers (fix first)', '');
    for (const issue of report.validation.errors) {
      lines.push(`- ✗ **${issue.file}**: ${issue.message}`);
    }
    lines.push('');
  }

  if (report.actions.length > 0) {
    lines.push(
      '### Drift actions',
      '',
      'Two-signal drift: `upstream-updated` = the bundled template moved since your last finalize',
      '(apply the diff); `conflict` = the template moved **and** you edited the file (merge, keep',
      'repo-specific customizations); `missing` = a template file is absent from `.har/`.',
      '',
      '| File | Status | Reference |',
      '|------|--------|-----------|',
    );
    for (const action of report.actions) {
      const ref =
        action.kind === 'missing'
          ? `maintain/templates/${action.file}`
          : `maintain/diffs/${action.file}.diff`;
      lines.push(`| ${action.file} | ${action.kind} | ${ref} |`);
    }
    lines.push('');
  }

  if (report.adapted.length > 0) {
    lines.push(
      '### Adapted files (no action)',
      '',
      'Local edits since the last finalize, with no upstream template change. Do **not** revert these to',
      'the stock template — finalize blesses them as the new baseline.',
      '',
      ...report.adapted.map((f) => `- \`${f}\``),
      '',
    );
  }

  if (report.pluginActions.length > 0) {
    lines.push(
      '### Plugin drift',
      '',
      '| Plugin | File | Status | Reference |',
      '|--------|------|--------|-----------|',
    );
    for (const action of report.pluginActions) {
      const ref =
        action.kind === 'missing'
          ? `maintain/plugins/${action.pluginId}/templates/${action.file}`
          : `maintain/plugins/${action.pluginId}/diffs/${action.file}.diff`;
      lines.push(`| ${action.pluginId} | ${action.file} | ${action.kind} | ${ref} |`);
    }
    lines.push('');
  }

  if (report.stale.length > 0) {
    lines.push('### Stale files', '');
    for (const stale of report.stale) {
      lines.push(`- **${stale.file}** — ${stale.hint}`);
    }
    lines.push('');
  }

  if (report.missingPortVars.length > 0) {
    lines.push('### Missing port vars in harness.env', '');
    for (const v of report.missingPortVars) {
      lines.push(`- \`${v}\` — see \`maintain/templates/harness.env\``);
    }
    lines.push('');
  }

  if (report.agentSlotMismatch) {
    lines.push(
      '### Agent slot limit mismatch',
      '',
      `- \`stages.json\` agentSlots: ${report.agentSlotMismatch.stages.min}–${report.agentSlotMismatch.stages.max}`,
      `- \`harness.env\` HARNESS_AGENT_SLOT_*: ${report.agentSlotMismatch.env.min}–${report.agentSlotMismatch.env.max}`,
      '',
      'Canonical source is `.har/stages.json`. `har env maintain --finalize` syncs legacy exports in `harness.env`.',
      '',
    );
  }

  if (report.instructionFiles.length > 0) {
    lines.push(
      '### Agent instruction files (generator 0.5.0 — outside `.har/` drift)',
      '',
      'These are **not** checksum drift rows. Apply them while adapting (HAR also migrates/scaffolds on maintain):',
      '',
    );
    for (const note of report.instructionFiles) {
      lines.push(`- **\`${note.path}\`** (${note.kind}): ${note.message}`);
    }
    lines.push('');
  }

  if (
    report.actions.length === 0 &&
    report.pluginActions.length === 0 &&
    report.stale.length === 0 &&
    report.missingPortVars.length === 0 &&
    !report.agentSlotMismatch &&
    report.validation.errors.length === 0 &&
    report.instructionFiles.length === 0
  ) {
    lines.push('No template drift detected. Review repo stack changes manually if needed.', '');
  }

  return lines.join('\n');
}
