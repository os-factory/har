import * as fs from 'fs';
import * as path from 'path';
import { scaffoldHarnessBoilerplate, finalizeHarness, ScaffoldOptions } from '../harness/generator';
import { retireLifecycleShims } from '../harness/lifecycle-shims';
import { finalizeAgentsMdInstructionFiles } from '../harness/agent-md';
import { validateHarness, smokeTestHarness, ValidationResult } from '../harness/validator';
import { compareHarnessToTemplate, HarnessDriftResult } from '../harness/drift';
import {
  buildMaintainBundle,
  MaintainBundleResult,
  removeMaintainBundle,
} from '../harness/maintain-bundle';
import { readManifest, getHarnessDir } from '../harness/manifest';
import { getVerificationStageIds, getAgentSlotRange, listStages, syncAgentSlotsToHarnessEnv } from '../harness/stages';
import { ensureEcosystemVerificationStages } from '../harness/verification';
import { DoctorReport, runDoctor } from '../harness/doctor';
import {
  AppliedMigration,
  MigrationPlan,
  pendingMigrations,
  removeMigrationArtifacts,
  writeMigrationPlan,
} from '../harness/migrations';
import { buildMigrationPrompt, writeMigrationPrompt } from '../harness/migrate-prompt';
import {
  applyPlugin,
  ApplyPluginOptions,
  ApplyPluginResult,
  PluginId,
} from '../harness/plugins';
import { harnessExists } from '../harness/parser';
import { HarnessManifest, HarnessStage } from '../harness/schema';

export interface InitHarnessOptions extends ScaffoldOptions {
  repoPath: string;
  verbose?: boolean;
  smoke?: boolean;
}

export interface InitHarnessResult {
  harnessDir: string;
  validation: ValidationResult;
  smoke?: ValidationResult;
}

export interface MaintainHarnessOptions {
  repoPath: string;
  verbose?: boolean;
  finalize?: boolean;
  summary?: string;
  /** Apply the pending mechanical migration steps (#241). */
  migrate?: boolean;
}

/** Pre-1.0 → 1.0 migration state surfaced by maintain (#241). */
export interface MaintainMigrationInfo {
  migrationId: string;
  to: string;
  title: string;
  /** True when `--migrate` ran the mechanical steps this invocation. */
  applied: boolean;
  plan: MigrationPlan;
  appliedResult?: AppliedMigration;
  /** Absolute path of the generated .har/MIGRATE-PROMPT.md. */
  promptPath: string;
  prompt: string;
}

export interface MaintainHarnessResult {
  validation: ValidationResult;
  drift: HarnessDriftResult;
  /** Contract validation (#232) — runs automatically on every maintain. */
  doctor: DoctorReport;
  bundle?: MaintainBundleResult;
  /** Set when the harness has (or just applied) a pending shape migration (#241). */
  migration?: MaintainMigrationInfo;
}

export interface ProjectDescription {
  repoPath: string;
  harnessPresent: boolean;
  manifest: HarnessManifest | null;
  scripts: string[];
  stages: HarnessStage[];
  verificationStages: string[];
  agentSlots: { min: number; max: number } | null;
  stackHints: {
    language?: string;
    packageManager?: string;
    database?: string;
  };
  harnessDrift: HarnessDriftResult | null;
}

function listHarnessScripts(repoPath: string): string[] {
  const harnessDir = getHarnessDir(repoPath);
  if (!fs.existsSync(harnessDir)) return [];

  return fs
    .readdirSync(harnessDir)
    .filter((name) => name.endsWith('.sh'))
    .sort();
}

export function describeProject(repoPath: string): ProjectDescription {
  const resolved = path.resolve(repoPath);
  const manifest = readManifest(resolved);
  const present = harnessExists(resolved);

  return {
    repoPath: resolved,
    harnessPresent: present,
    manifest,
    scripts: listHarnessScripts(resolved),
    stages: present ? listStages(resolved) : [],
    verificationStages: present ? getVerificationStageIds(resolved) : [],
    agentSlots: present ? getAgentSlotRange(resolved) : null,
    stackHints: {
      language: manifest?.stack?.language,
      packageManager: manifest?.stack?.packageManager,
      database: manifest?.stack?.database,
    },
    harnessDrift: present ? compareHarnessToTemplate(resolved) : null,
  };
}

export async function initHarness(options: InitHarnessOptions): Promise<InitHarnessResult> {
  const repoPath = path.resolve(options.repoPath);

  if (!fs.existsSync(repoPath)) {
    throw new Error(`Path not found: ${repoPath}`);
  }

  const scaffold = scaffoldHarnessBoilerplate(repoPath, {
    force: options.force,
    profile: options.profile,
  });
  syncAgentSlotsToHarnessEnv(repoPath);
  ensureEcosystemVerificationStages(repoPath);

  const validation = validateHarness(repoPath);
  let smoke: ValidationResult | undefined;
  if (options.smoke) {
    smoke = await smokeTestHarness(repoPath);
  }

  return {
    harnessDir: scaffold.harnessDir,
    validation,
    smoke,
  };
}

export async function maintainHarness(options: MaintainHarnessOptions): Promise<MaintainHarnessResult> {
  const repoPath = path.resolve(options.repoPath);
  const harnessDir = getHarnessDir(repoPath);

  if (!fs.existsSync(harnessDir)) {
    throw new Error('No .har/ found. Run "har env init" first.');
  }

  // Versioned migrations (#241): a pre-1.0 harness is detected on every
  // maintain. Plain maintain only plans + writes the MIGRATE prompt (compat
  // window — nothing changes); `--migrate` applies the mechanical steps with
  // backups under .har/migrate/backup/.
  let migration: MaintainMigrationInfo | undefined;
  const pending = pendingMigrations(repoPath);
  if (pending.length > 0 && !options.finalize) {
    const next = pending[0];
    if (options.migrate) {
      const applied = next.apply(repoPath);
      const prompt = buildMigrationPrompt(applied.plan, applied);
      const promptPath = writeMigrationPrompt(repoPath, prompt);
      migration = {
        migrationId: next.id,
        to: next.to,
        title: next.title,
        applied: true,
        plan: applied.plan,
        appliedResult: applied,
        promptPath,
        prompt,
      };
    } else {
      const plan = next.plan(repoPath);
      writeMigrationPlan(repoPath, plan);
      const prompt = buildMigrationPrompt(plan, null);
      const promptPath = writeMigrationPrompt(repoPath, prompt);
      migration = {
        migrationId: next.id,
        to: next.to,
        title: next.title,
        applied: false,
        plan,
        promptPath,
        prompt,
      };
    }
  }

  // #314: leftover managed/ejected lifecycle wrappers are not an entry point.
  // Safe on pre-1.0: vendored runtime bash is not managed-shim content.
  retireLifecycleShims(repoPath);

  ensureEcosystemVerificationStages(repoPath);
  const drift = compareHarnessToTemplate(repoPath);
  const validation = validateHarness(repoPath);

  if (options.finalize) {
    if (!validation.pass) {
      throw new Error('Cannot finalize: harness validation has errors. Fix them first.');
    }
    syncAgentSlotsToHarnessEnv(repoPath);
    finalizeAgentsMdInstructionFiles(repoPath);
    const existing = readManifest(repoPath);
    finalizeHarness(
      repoPath,
      options.summary ?? 'Manual adaptation finalized via har env maintain --finalize',
      existing?.stack,
    );
    removeMaintainBundle(repoPath);
    // Migration artifacts (backups, plan, prompt) are kept until the harness
    // is actually on the 1.0 shape — finalize on a still-pre-1.0 harness must
    // not destroy the only copy of the vendored scripts.
    if (pendingMigrations(repoPath).length === 0) {
      removeMigrationArtifacts(repoPath);
    }
    return {
      validation,
      drift: compareHarnessToTemplate(repoPath),
      doctor: runDoctor(repoPath),
    };
  }

  const bundle = buildMaintainBundle(repoPath, validation, drift);

  return {
    validation,
    drift,
    doctor: runDoctor(repoPath),
    bundle,
    migration,
  };
}

export function addPlugin(
  repoPath: string,
  pluginId: PluginId,
  options: ApplyPluginOptions = {},
): ApplyPluginResult {
  return applyPlugin(repoPath, pluginId, options);
}

/** @deprecated Use addPlugin */
export function addStageTemplate(
  repoPath: string,
  pluginId: PluginId,
  options: ApplyPluginOptions = {},
): ApplyPluginResult {
  return addPlugin(repoPath, pluginId, options);
}
