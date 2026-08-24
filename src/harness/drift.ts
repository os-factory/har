import * as fs from 'fs';
import * as path from 'path';
import type { HarnessProfile } from './generator';
import { readHarnessEnv } from './env';
import {
  harnessFileForTemplate,
  isExpectedHarnessOnlyFile,
  templateFileForHarness,
} from './gitignore-template';
import {
  computeFileChecksum,
  getHarnessDir,
  readManifest,
} from './manifest';
import { detectAgentSlotEnvMismatch } from './stages';
import { composeProfileTemplateMap, readComposedTemplateContent } from './profiles';
import { RUNTIME_SHIM_FILES, substituteTemplateTokens } from './template-tokens';

const CLI_EXPECTED_ABSENT = new Set([
  'ecosystem.agent.template.cjs',
  'env.template',
  'attach.sh',
]);

export type DriftFileStatus =
  | 'unchanged'
  | 'user-adapted'
  | 'upstream-updated'
  | 'conflict';

/** Per-file cross product of the two drift signals (#237). */
export interface DriftFileEntry {
  file: string;
  status: DriftFileStatus;
  /** Signal 1 — installed file differs from fileChecksums recorded at last finalize. */
  userEdited: boolean;
  /**
   * Signal 2 — bundled template differs from templateChecksums recorded at last
   * finalize. `null` = no template baseline in the manifest (pre-#237 finalize);
   * upstream updates cannot be detected until the next `maintain --finalize`.
   */
  upstreamUpdated: boolean | null;
}

export interface HarnessDriftResult {
  /** Two-signal detail for every template-tracked file present in .har/. */
  files: DriftFileEntry[];
  missing: string[];
  /** User edited since last finalize; template unchanged. Informational, not an action. */
  userAdapted: string[];
  /** Template updated since last finalize; user did not touch the file. */
  upstreamUpdated: string[];
  /** Both signals fired — needs a real merge. */
  conflict: string[];
  extra: string[];
  unchanged: string[];
  /**
   * User-owned files never compared to upstream templates: on an ejected
   * harness (#239), the runtime scripts and vendored runtime belong to the
   * user and report no drift.
   */
  ownedByUser: string[];
  /** Port-allocation knobs from harness.env that the bundled template expects. */
  missingPortVars: string[];
  /** stages.json agentSlots disagree with HARNESS_AGENT_SLOT_* in harness.env. */
  agentSlotMismatch: {
    stages: { min: number; max: number };
    env: { min: number; max: number };
  } | null;
}

const APP_PORT_VARS = [
  'HARNESS_FE_BASE_PORT',
  'HARNESS_API_BASE_PORT',
  'HARNESS_PORT_STEP',
] as const;

/** Lanes each compose service needs in HARNESS_INFRA_PORT_LANES (1.0 contract). */
const INFRA_PORT_LANES_BY_SERVICE: Record<string, readonly string[]> = {
  db: ['db'],
  minio: ['minio', 'minio-console'],
  mailpit: ['mailpit-web', 'mailpit-smtp'],
  'headless-browser': ['browser'],
};

const INFRA_PORT_VARS_BY_SERVICE: Record<string, readonly string[]> = {
  db: [
    'HARNESS_DB_PORT_DEFAULT',
    'HARNESS_DB_PORT_SCAN_START',
    'HARNESS_DB_PORT_SCAN_END',
  ],
  minio: [
    'HARNESS_MINIO_PORT_DEFAULT',
    'HARNESS_MINIO_PORT_SCAN_START',
    'HARNESS_MINIO_PORT_SCAN_END',
    'HARNESS_MINIO_CONSOLE_PORT_DEFAULT',
    'HARNESS_MINIO_CONSOLE_PORT_SCAN_START',
    'HARNESS_MINIO_CONSOLE_PORT_SCAN_END',
  ],
  mailpit: [
    'HARNESS_MAILPIT_WEB_PORT_DEFAULT',
    'HARNESS_MAILPIT_WEB_PORT_SCAN_START',
    'HARNESS_MAILPIT_WEB_PORT_SCAN_END',
    'HARNESS_MAILPIT_SMTP_PORT_DEFAULT',
    'HARNESS_MAILPIT_SMTP_PORT_SCAN_START',
    'HARNESS_MAILPIT_SMTP_PORT_SCAN_END',
  ],
  'headless-browser': [
    'HARNESS_BROWSER_PORT_DEFAULT',
    'HARNESS_BROWSER_PORT_SCAN_START',
    'HARNESS_BROWSER_PORT_SCAN_END',
  ],
};

/** Returns harness.env export names missing for the profile and enabled infra services. */
export function missingPortDocumentationVars(
  profile: HarnessProfile,
  env: Record<string, string>,
): string[] {
  const missing: string[] = [];

  if (profile === 'default') {
    for (const key of APP_PORT_VARS) {
      if (!(key in env)) missing.push(key);
    }
  }

  if (profile === 'cli' && !('HARNESS_PORT_STEP' in env)) {
    missing.push('HARNESS_PORT_STEP');
  }

  const services = (env.HARNESS_INFRA_SERVICES ?? '').trim().split(/\s+/).filter(Boolean);
  const declaredLanes = new Set(
    (env.HARNESS_INFRA_PORT_LANES ?? '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((entry) => entry.split('=')[0]),
  );
  for (const service of services) {
    const lanes = INFRA_PORT_LANES_BY_SERVICE[service];
    if (lanes && lanes.every((lane) => declaredLanes.has(lane))) continue;
    const vars = INFRA_PORT_VARS_BY_SERVICE[service];
    if (!vars) continue;
    if (vars.some((key) => !(key in env))) {
      // Neither a lane declaration nor the legacy triplets — report the lane
      // entries the 1.0 contract expects in HARNESS_INFRA_PORT_LANES.
      missing.push(...(lanes ?? []).map((lane) => `HARNESS_INFRA_PORT_LANES:${lane}`));
    }
  }

  return [...new Set(missing)];
}

const substituteProjectName = substituteTemplateTokens;

function projectNameFor(resolvedRepoPath: string): string {
  return path.basename(resolvedRepoPath).toLowerCase().replace(/[^a-z0-9]/g, '_');
}

/**
 * Checksums of the composed bundled templates, keyed by installed file name
 * (same key space as manifest fileChecksums). Recorded into the manifest at
 * init/finalize as the baseline for the upstream-updated signal.
 */
export function computeTemplateChecksums(
  repoPath: string,
  profile: HarnessProfile,
): Record<string, string> {
  const resolved = path.resolve(repoPath);
  const projectName = projectNameFor(resolved);
  const checksums: Record<string, string> = {};
  for (const [file, entry] of composeProfileTemplateMap(profile)) {
    // Render generation-time tokens for every file — the comparison in
    // compareHarnessToTemplate hashes rendered templates, so the recorded
    // baseline must be rendered the same way or fresh shims (__HAR_VERSION__)
    // report false upstream updates.
    const content = substituteProjectName(readComposedTemplateContent(entry), projectName);
    checksums[harnessFileForTemplate(file)] = computeFileChecksum(content);
  }
  return checksums;
}

export function compareHarnessToTemplate(repoPath: string): HarnessDriftResult {
  const resolved = path.resolve(repoPath);
  const manifest = readManifest(resolved);
  const profile: HarnessProfile = manifest?.profile ?? 'default';
  const harnessDir = getHarnessDir(resolved);
  const projectName = projectNameFor(resolved);
  // Composed bundle set (shared kernel → runtime bundle → overlay), including
  // subdirectory entries (stages/…) — drift recurses into .har/stages/ (#237).
  const composed = composeProfileTemplateMap(profile);
  const templateFiles = [...composed.keys()].sort();
  const fileBaseline = manifest?.fileChecksums;
  const templateBaseline = manifest?.templateChecksums;

  const files: DriftFileEntry[] = [];
  const missing: string[] = [];
  const userAdapted: string[] = [];
  const upstreamUpdated: string[] = [];
  const conflict: string[] = [];
  const extra: string[] = [];
  const unchanged: string[] = [];
  const ownedByUser: string[] = [];
  // Ejected harness (#239): the runtime scripts are user-owned — a present
  // script is never drift, only a missing one still is (the harness is broken).
  const ejected = manifest?.ejected === true;
  const userOwnedFiles = new Set<string>(ejected ? RUNTIME_SHIM_FILES : []);

  for (const file of templateFiles) {
    const harnessFile = harnessFileForTemplate(file);
    const harnessPath = path.join(harnessDir, harnessFile);
    if (userOwnedFiles.has(harnessFile) && fs.existsSync(harnessPath)) {
      ownedByUser.push(harnessFile);
      continue;
    }
    // Render generation-time tokens (__PROJECT_NAME__, __HAR_VERSION__) so the
    // comparison matches what the generator actually wrote — otherwise every
    // fresh shim reports false drift against its own unrendered template.
    const templateContent = substituteProjectName(
      readComposedTemplateContent(composed.get(file)!),
      projectName,
    );

    if (!fs.existsSync(harnessPath)) {
      missing.push(harnessFile);
      continue;
    }

    const installedChecksum = computeFileChecksum(fs.readFileSync(harnessPath, 'utf8'));
    const templateChecksum = computeFileChecksum(templateContent);
    const recordedFile = fileBaseline?.[harnessFile];
    const recordedTemplate = templateBaseline?.[harnessFile];

    // Signal 1 — user-edited since last finalize. Without a recorded file
    // checksum (no finalize yet), any divergence from the template counts.
    const userEdited =
      recordedFile !== undefined
        ? installedChecksum !== recordedFile
        : installedChecksum !== templateChecksum;

    // Signal 2 — upstream template moved since last finalize. Without a
    // recorded template baseline (pre-#237 manifest) upstream updates are
    // undetectable: report `null`, never guess — a finalize-blessed adaptation
    // must not resurface as drift noise.
    const upstream: boolean | null =
      recordedTemplate !== undefined ? templateChecksum !== recordedTemplate : null;

    const status: DriftFileStatus =
      userEdited && upstream
        ? 'conflict'
        : userEdited
          ? 'user-adapted'
          : upstream
            ? 'upstream-updated'
            : 'unchanged';

    files.push({ file: harnessFile, status, userEdited, upstreamUpdated: upstream });
    if (status === 'unchanged') unchanged.push(harnessFile);
    else if (status === 'user-adapted') userAdapted.push(harnessFile);
    else if (status === 'upstream-updated') upstreamUpdated.push(harnessFile);
    else conflict.push(harnessFile);
  }

  if (fs.existsSync(harnessDir)) {
    for (const file of fs.readdirSync(harnessDir)) {
      const full = path.join(harnessDir, file);
      // Directories are skipped, which also keeps `.har/hooks/` (#238) out of
      // drift entirely: hooks are user-owned, never compared to templates.
      if (!fs.statSync(full).isFile()) continue;
      if (
        file === 'manifest.json' ||
        file === 'plugins.json' ||
        file.startsWith('ADAPT-PROMPT')
      ) {
        continue;
      }
      if (profile === 'cli' && CLI_EXPECTED_ABSENT.has(file)) {
        extra.push(file);
      } else if (isExpectedHarnessOnlyFile(file, templateFiles)) {
        continue;
      } else if (
        !templateFiles.includes(file) &&
        !templateFiles.includes(templateFileForHarness(file))
      ) {
        extra.push(file);
      }
    }
  }

  const harnessEnv = readHarnessEnv(resolved);
  const missingPortVars = missingPortDocumentationVars(profile, harnessEnv);
  const agentSlotMismatch = detectAgentSlotEnvMismatch(resolved);

  return {
    files,
    missing,
    userAdapted,
    upstreamUpdated,
    conflict,
    extra,
    unchanged,
    ownedByUser,
    missingPortVars,
    agentSlotMismatch,
  };
}
