import * as path from 'path';
import { addPlugin, initHarness } from './harness';
import { startControlAndSync } from './control-lifecycle';
import { getControlApiUrl } from './control-config';
import { ensureRepoRegisteredWithControl, isControlApiReachable } from './control-sync';
import {
  disableOtelHooksExport,
  ensureOtelHooks,
} from './otel-hooks';
import {
  writeTelemetryPreference,
} from './telemetry-config';
import { ensureTelemetryInfrastructure } from './telemetry-ensure';
import {
  buildInitAdaptationPrompt,
  buildMaintainAdaptationPrompt,
  offerAdaptationPromptClipboard,
  printAdaptationPrompt,
  writeAdaptationPrompt,
} from '../harness/adaptation-prompt';
import type { HarnessProfile } from '../harness/generator';
import { harnessExists } from '../harness/parser';
import {
  listPluginIds,
  PluginId,
  readPluginManifest,
} from '../harness/plugins';
import { divider, info, success, warn } from '../utils/logging';

export type TelemetryChoice = 'on' | 'on-no-prompts' | 'off';

export interface PluginChoice {
  id: PluginId;
  label: string;
  description: string;
}

/** Short guided tour shown at the start of `har onboard`. */
export const ONBOARDING_GUIDE_STEPS: readonly { title: string; body: string }[] = [
  {
    title: 'What HAR is',
    body: [
      'HAR (Harness) gives coding agents a reproducible environment for your repo:',
      'an editable `.har/` scaffold, isolated git worktree sessions, and a verify → complete loop.',
      'You adapt the scaffold once to your stack; agents then use the same launch/verify/teardown contract.',
    ].join('\n'),
  },
  {
    title: 'Sessions and slots',
    body: [
      'Each `har env launch <id>` creates a fresh session worktree from your main checkout HEAD.',
      'Edit only under the printed work dir — never the main checkout while a slot is active.',
      'Use separate slot ids for parallel tasks. Prefer `complete` / `teardown` before starting unrelated work.',
    ].join('\n'),
  },
  {
    title: 'Verify and finish',
    body: [
      'Quick:  har env verify <id>',
      'Done:   har env verify <id> --full   then   har env complete <id>',
      '`complete` records a validation, frees the slot, and keeps the session branch for a PR.',
    ].join('\n'),
  },
  {
    title: 'Mission Control and plugins',
    body: [
      'Mission Control is a local dashboard for slots, runs, and (optional) agent usage telemetry.',
      'Plugins (`har env add-plugin`) add optional verification stages such as Playwright browser-e2e.',
      'After setup, paste the adaptation prompt into your coding agent to tailor `.har/` to this repo.',
    ].join('\n'),
  },
];

export interface OnboardOptions {
  repoPath: string;
  profile: HarnessProfile;
  telemetry: TelemetryChoice;
  startControl: boolean;
  plugins: PluginId[];
  /** Do not scaffold `.har/` (even when missing). */
  skipInit?: boolean;
  /** Skip scaffolding when `.har/` already exists (default: true). */
  skipInitIfPresent?: boolean;
  /** Defer writing/copying the adaptation prompt to the caller (default: false). */
  deferAdaptationPrompt?: boolean;
  autoYes?: boolean;
  /** Force overwrite when applying plugins. */
  forcePlugins?: boolean;
}

export interface OnboardResult {
  repoPath: string;
  profile: HarnessProfile;
  harnessInitialized: boolean;
  harnessAlreadyPresent: boolean;
  telemetry: TelemetryChoice;
  controlStarted: boolean;
  controlApiUrl: string;
  pluginsApplied: PluginId[];
  pluginWarnings: string[];
  adaptationPromptPath: string | null;
  adaptationPromptCopied: boolean;
}

export interface OnboardingDeps {
  applyTelemetry?: (choice: TelemetryChoice) => Promise<void>;
  ensureControl?: (options: {
    startControl: boolean;
    telemetry: TelemetryChoice;
    cwd: string;
  }) => Promise<{ started: boolean; apiUrl: string; warning?: string }>;
  initHarness?: typeof initHarness;
  addPlugin?: typeof addPlugin;
  offerClipboard?: typeof offerAdaptationPromptClipboard;
}

export function listPluginChoices(): PluginChoice[] {
  return listPluginIds().map((id) => {
    try {
      const manifest = readPluginManifest(id);
      const description =
        typeof manifest.stage.description === 'string'
          ? manifest.stage.description
          : `Adds stage ${manifest.stageId}`;
      return {
        id,
        label: `${id} — ${description}`,
        description,
      };
    } catch {
      return { id, label: id, description: id };
    }
  });
}

export function printOnboardingGuide(): void {
  divider();
  info('How HAR works');
  divider();
  for (const [index, step] of ONBOARDING_GUIDE_STEPS.entries()) {
    info(`${index + 1}. ${step.title}`);
    for (const line of step.body.split('\n')) {
      info(`   ${line}`);
    }
    info('');
  }
}

export async function applyOnboardingTelemetry(
  choice: TelemetryChoice,
  options: { setupHooks?: boolean } = {},
): Promise<void> {
  const setupHooks = options.setupHooks !== false;

  if (choice === 'off') {
    writeTelemetryPreference(false);
    if (setupHooks) {
      try {
        disableOtelHooksExport();
      } catch (err) {
        warn(`Could not refresh hooks config: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    success('Telemetry disabled');
    return;
  }

  const prompts = choice === 'on';
  writeTelemetryPreference(true, { prompts, traces: true });
  success(
    prompts
      ? 'Telemetry enabled (including prompts) → Mission Control via @osfactory/otel-hook'
      : 'Telemetry enabled without prompt capture',
  );
  if (setupHooks) {
    const hooks = ensureOtelHooks({ setupAgents: true });
    if (hooks.message) success(hooks.message);
    if (hooks.warning) warn(hooks.warning);
  }
}

export async function defaultEnsureControl(options: {
  startControl: boolean;
  telemetry: TelemetryChoice;
  cwd: string;
}): Promise<{ started: boolean; apiUrl: string; warning?: string }> {
  const apiUrl = getControlApiUrl();

  if (!options.startControl) {
    if (options.telemetry !== 'off') {
      // Keep hooks/preference wired, but do not auto-start Mission Control.
      await ensureTelemetryInfrastructure({ startIfNeeded: false });
      const reachable = await isControlApiReachable(apiUrl);
      if (!reachable) {
        return {
          started: false,
          apiUrl,
          warning:
            'Telemetry is on but Mission Control is not running. Start later with: har control up',
        };
      }
      // MC is already reachable — register now so OTLP ingest from otel-hook
      // doesn't drop events waiting for the next sync.
      await ensureRepoRegisteredWithControl(options.cwd, apiUrl);
    }
    return { started: false, apiUrl };
  }

  if (options.telemetry !== 'off') {
    const ensured = await ensureTelemetryInfrastructure({ startIfNeeded: true });
    if (ensured.message) success(ensured.message);
    if (ensured.warning) warn(ensured.warning);
    if (ensured.reachable) {
      await ensureRepoRegisteredWithControl(options.cwd, ensured.apiUrl);
    }
    return {
      started: ensured.started || ensured.reachable,
      apiUrl: ensured.apiUrl,
      warning: ensured.warning,
    };
  }

  const result = await startControlAndSync({ detach: true, cwd: options.cwd });
  if (result.code !== 0) {
    return {
      started: false,
      apiUrl: result.apiUrl,
      warning: 'Failed to start Mission Control (is Docker available?)',
    };
  }
  success(`Mission Control started at ${result.apiUrl}`);
  return { started: true, apiUrl: result.apiUrl };
}

/**
 * Run the non-interactive parts of onboarding after the CLI has collected choices.
 */
export async function runOnboarding(
  options: OnboardOptions,
  deps: OnboardingDeps = {},
): Promise<OnboardResult> {
  const repoPath = path.resolve(options.repoPath);
  const applyTelemetry = deps.applyTelemetry ?? applyOnboardingTelemetry;
  const ensureControl = deps.ensureControl ?? defaultEnsureControl;
  const init = deps.initHarness ?? initHarness;
  const applyPlugin = deps.addPlugin ?? addPlugin;
  const offerClipboard = deps.offerClipboard ?? offerAdaptationPromptClipboard;

  await applyTelemetry(options.telemetry);

  const control = await ensureControl({
    startControl: options.startControl,
    telemetry: options.telemetry,
    cwd: repoPath,
  });
  if (control.warning) warn(control.warning);

  const alreadyPresent = harnessExists(repoPath);
  let harnessInitialized = false;
  const shouldInit =
    !options.skipInit && !(alreadyPresent && options.skipInitIfPresent !== false);

  if (options.skipInit) {
    info('Skipping harness scaffold (--skip-init)');
  } else if (alreadyPresent && options.skipInitIfPresent !== false) {
    info('Harness already present — skipping scaffold');
  } else if (shouldInit) {
    divider();
    info(`Scaffolding .har/ (profile: ${options.profile})...`);
    const result = await init({
      repoPath,
      profile: options.profile,
      force: alreadyPresent,
      auto: false,
    });
    if (!result.validation.pass) {
      warn('Harness has validation errors — review .har/ after adaptation.');
    }
    harnessInitialized = true;
    success('Harness scaffolded');
  }

  const pluginsApplied: PluginId[] = [];
  const pluginWarnings: string[] = [];

  if (options.plugins.length > 0) {
    if (!harnessExists(repoPath)) {
      warn('Cannot install plugins without a harness — skipping');
    } else {
      divider();
      info(`Installing plugins: ${options.plugins.join(', ')}`);
      for (const pluginId of options.plugins) {
        try {
          const result = applyPlugin(repoPath, pluginId, {
            force: options.forcePlugins === true,
          });
          pluginsApplied.push(pluginId);
          success(`Plugin ${pluginId} → stage ${result.stageId}`);
          for (const w of result.warnings) pluginWarnings.push(w);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          pluginWarnings.push(`${pluginId}: ${message}`);
          warn(`Plugin ${pluginId} failed: ${message}`);
        }
      }
    }
  }

  let adaptationPromptPath: string | null = null;
  let adaptationPromptCopied = false;

  if (!options.deferAdaptationPrompt && harnessExists(repoPath)) {
    const finalized = await finalizeOnboardingAdaptation({
      repoPath,
      profile: options.profile,
      harnessInitialized,
      autoYes: options.autoYes,
      offerClipboard,
    });
    adaptationPromptPath = finalized.path;
    adaptationPromptCopied = finalized.copied;
  }

  return {
    repoPath,
    profile: options.profile,
    harnessInitialized,
    harnessAlreadyPresent: alreadyPresent,
    telemetry: options.telemetry,
    controlStarted: control.started,
    controlApiUrl: control.apiUrl,
    pluginsApplied,
    pluginWarnings,
    adaptationPromptPath,
    adaptationPromptCopied,
  };
}

/** Write, print, and optionally copy the adaptation prompt (final onboarding step). */
export async function finalizeOnboardingAdaptation(options: {
  repoPath: string;
  profile: HarnessProfile;
  harnessInitialized: boolean;
  autoYes?: boolean;
  offerClipboard?: typeof offerAdaptationPromptClipboard;
}): Promise<{ path: string; copied: boolean }> {
  const offerClipboard = options.offerClipboard ?? offerAdaptationPromptClipboard;
  const mode = options.harnessInitialized ? 'init' : 'maintain';
  const prompt =
    mode === 'init'
      ? buildInitAdaptationPrompt(options.repoPath, options.profile)
      : buildMaintainAdaptationPrompt(options.repoPath);
  const filePath = writeAdaptationPrompt(options.repoPath, prompt);

  divider();
  info(
    mode === 'init'
      ? 'Adapt the harness with your coding agent (final step):'
      : 'Optional: paste this maintenance prompt into your coding agent:',
  );
  info('  Also saved to .har/ADAPT-PROMPT.md');
  printAdaptationPrompt(prompt);
  const copied = await offerClipboard(prompt, { autoYes: options.autoYes });
  return { path: filePath, copied };
}
