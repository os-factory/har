import * as fs from 'fs';
import * as path from 'path';
import { scaffoldHarnessBoilerplate, finalizeHarness, ScaffoldOptions } from '../harness/generator';
import { authorHarness } from '../llm/authoring-agent';
import { validateHarness, smokeTestHarness, ValidationResult } from '../harness/validator';
import { readManifest, getHarnessDir } from '../harness/manifest';
import { getVerificationStageIds, getAgentSlotRange, listStages } from '../harness/stages';
import { harnessExists } from '../harness/parser';
import { requireApiKey } from '../utils/validation';
import { HarnessManifest, HarnessStage } from '../harness/schema';

export interface InitHarnessOptions extends ScaffoldOptions {
  repoPath: string;
  auto?: boolean;
  verbose?: boolean;
  model?: string;
  smoke?: boolean;
}

export interface InitHarnessResult {
  harnessDir: string;
  validation: ValidationResult;
  smoke?: ValidationResult;
  adaptationSummary?: string;
}

export interface MaintainHarnessOptions {
  repoPath: string;
  auto?: boolean;
  verbose?: boolean;
  model?: string;
}

export interface MaintainHarnessResult {
  validation: ValidationResult;
  adaptationSummary?: string;
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
  let adaptationSummary: string | undefined;

  if (options.auto) {
    const apiKey = requireApiKey();
    const authoringResult = await authorHarness(repoPath, apiKey, {
      verbose: options.verbose,
      model: options.model,
      mode: 'init',
    });
    adaptationSummary = authoringResult.summary;
    finalizeHarness(repoPath, authoringResult.summary, authoringResult.stack);
  }

  const validation = validateHarness(repoPath);
  let smoke: ValidationResult | undefined;
  if (options.smoke) {
    smoke = await smokeTestHarness(repoPath);
  }

  return {
    harnessDir: scaffold.harnessDir,
    validation,
    smoke,
    adaptationSummary,
  };
}

export async function maintainHarness(options: MaintainHarnessOptions): Promise<MaintainHarnessResult> {
  const repoPath = path.resolve(options.repoPath);
  const harnessDir = getHarnessDir(repoPath);

  if (!fs.existsSync(harnessDir)) {
    throw new Error('No .har/ found. Run "har env init" first.');
  }

  if (options.auto) {
    const apiKey = requireApiKey();
    const authoringResult = await authorHarness(repoPath, apiKey, {
      verbose: options.verbose,
      model: options.model,
      mode: 'maintain',
    });

    finalizeHarness(repoPath, authoringResult.summary, authoringResult.stack);
    const validation = validateHarness(repoPath);

    return {
      validation,
      adaptationSummary: authoringResult.summary,
    };
  }

  const validation = validateHarness(repoPath);

  return {
    validation,
    adaptationSummary: 'Manual maintenance — use coding agent prompt in .har/ADAPT-PROMPT.md',
  };
}
