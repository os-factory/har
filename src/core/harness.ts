import * as fs from 'fs';
import * as path from 'path';
import { scaffoldHarnessBoilerplate, finalizeHarness, ScaffoldOptions } from '../harness/generator';
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
}

export interface MaintainHarnessResult {
  validation: ValidationResult;
  drift: HarnessDriftResult;
  bundle?: MaintainBundleResult;
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
    return {
      validation,
      drift: compareHarnessToTemplate(repoPath),
    };
  }

  const bundle = buildMaintainBundle(repoPath, validation, drift);

  return {
    validation,
    drift,
    bundle,
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
