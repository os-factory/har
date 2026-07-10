import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileSafe } from '../utils/file-ops';
import { run } from '../utils/shell';
import type { HarnessProfile } from './generator';
import type { HarnessDriftResult } from './drift';
import { getHarnessDir, readManifest } from './manifest';
import { resolveTemplatesDir } from '../utils/paths';
import type { ValidationIssue, ValidationResult } from './validator';

export const MAINTAIN_DIR = 'maintain';

const PROFILE_DIRS: Record<HarnessProfile, string> = {
  default: 'har-boilerplate',
  cli: 'har-boilerplate-cli',
  ios: 'har-boilerplate-ios',
};

export type MaintainActionKind = 'missing' | 'drift';

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

export interface MaintainBundleReport {
  generatedAt: string;
  generatorVersion: HarnessDriftResult['generatorVersion'];
  profile: HarnessProfile;
  actions: MaintainAction[];
  stale: MaintainStaleFile[];
  missingPortVars: string[];
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

function substituteProjectName(content: string, projectName: string): string {
  return content
    .replace(/__PROJECT_NAME__/g, projectName)
    .replace(/template___PROJECT_NAME__/g, `template_${projectName}`);
}

function projectNameFromRepo(repoPath: string): string {
  return path.basename(repoPath).toLowerCase().replace(/[^a-z0-9]/g, '_');
}

function boilerplateDirForProfile(profile: HarnessProfile): string {
  return path.join(resolveTemplatesDir(), PROFILE_DIRS[profile]);
}

function readBundledTemplateContent(
  repoPath: string,
  profile: HarnessProfile,
  file: string,
): string {
  const templatePath = path.join(boilerplateDirForProfile(profile), file);
  let content = fs.readFileSync(templatePath, 'utf8');
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
  if (file === 'verify.sh') {
    return 'Merge template upgrades into .har/verify.sh — do not blind-overwrite repo-specific checks.';
  }
  if (file === 'harness.env') {
    return 'Merge template changes; keep repo-specific commands and add any missing port vars.';
  }
  return `Read maintain/diffs/${file}.diff and merge into .har/${file}.`;
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

  for (const file of drift.checksumMismatch) {
    const installedPath = path.join(harnessDir, file);
    const installedRel = `maintain/installed/${file}`;
    const templateRel = `maintain/templates/${file}`;
    const diffRel = `maintain/diffs/${file}.diff`;

    actions.push({
      file,
      kind: 'drift',
      template: templateRel,
      installed: fs.existsSync(installedPath) ? installedRel : undefined,
      diff: diffRel,
      hint: actionHint(file, 'drift'),
    });
  }

  return actions.sort((a, b) => a.file.localeCompare(b.file));
}

function buildStale(drift: HarnessDriftResult): MaintainStaleFile[] {
  return drift.extra
    .map((file) => ({ file, hint: staleFileHint(file) }))
    .sort((a, b) => a.file.localeCompare(b.file));
}

function buildReadme(report: MaintainBundleReport): string {
  const lines: string[] = [
    '# Harness maintenance bundle',
    '',
    `Generated by \`har env maintain\` on ${report.generatedAt}.`,
    `Bundled generator: ${report.generatorVersion.bundled} | Installed: ${report.generatorVersion.installed ?? '(unknown)'} | Profile: ${report.profile}`,
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

  lines.push('', '## Drift actions', '');

  if (report.actions.length === 0) {
    lines.push('No missing or drifted template files.');
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

  if (report.missingPortVars.length > 0) {
    lines.push('', '## Missing port vars in harness.env', '');
    for (const v of report.missingPortVars) {
      lines.push(`- \`${v}\` — copy from \`maintain/templates/harness.env\``);
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
    '1. Resolve each drift action (merge diffs; keep repo-specific customizations).',
    '2. Review stale files — delete or merge superseded scripts.',
    '3. Re-run `har env maintain` until validation passes and drift is clear.',
    '4. `har env maintain --finalize --summary "<what changed>"`',
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

  const affectedFiles = [...drift.missing, ...drift.checksumMismatch];
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

export function buildMaintainBundle(
  repoPath: string,
  validation: ValidationResult,
  drift: HarnessDriftResult,
): MaintainBundleResult {
  const manifest = readManifest(repoPath);
  const profile: HarnessProfile = manifest?.profile ?? 'default';
  const errors = validation.issues.filter((i) => i.severity === 'error');
  const warnings = validation.issues.filter((i) => i.severity === 'warning');

  const report: MaintainBundleReport = {
    generatedAt: new Date().toISOString(),
    generatorVersion: drift.generatorVersion,
    profile,
    actions: buildActions(repoPath, profile, drift),
    stale: buildStale(drift),
    missingPortVars: drift.missingPortVars,
    validation: {
      pass: validation.pass,
      errors,
      warnings,
    },
  };

  const bundleDir = writeBundleArtifacts(repoPath, profile, drift, report);
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
    'All reference templates are under `.har/maintain/templates/`.',
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
    lines.push('### Drift actions', '', '| File | Status | Reference |', '|------|--------|-----------|');
    for (const action of report.actions) {
      const ref =
        action.kind === 'missing'
          ? `maintain/templates/${action.file}`
          : `maintain/diffs/${action.file}.diff`;
      lines.push(`| ${action.file} | ${action.kind} | ${ref} |`);
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

  if (
    report.actions.length === 0 &&
    report.stale.length === 0 &&
    report.missingPortVars.length === 0 &&
    report.validation.errors.length === 0
  ) {
    lines.push('No template drift detected. Review repo stack changes manually if needed.', '');
  }

  return lines.join('\n');
}
