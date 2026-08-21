import * as path from 'path';
import inquirer from 'inquirer';
import type { Argv } from 'yargs';
import { harnessExists } from '../../harness/parser';
import type { HarnessProfile } from '../../harness/generator';
import { PluginId } from '../../harness/plugins';
import {
  HAR_AGENT_SLOT_MIN,
  HAR_AGENT_SLOT_ONBOARD_MAX,
  getAgentSlotRange,
} from '../../harness/stages';
import { handleCommitGateOnboarding } from '../../core/commit-gate-onboarding';
import {
  describeDockerStatus,
  detectDockerStatus,
  isDockerUsable,
  warnIfDockerUnavailable,
  type DockerStatus,
} from '../../core/docker-status';
import {
  finalizeOnboardingAdaptation,
  listPluginChoices,
  ONBOARDING_GUIDE_STEPS,
  printOnboardingGuide,
  runOnboarding,
  TelemetryChoice,
} from '../../core/onboarding';
import { divider, error, header, info, success, warn } from '../../utils/logging';
import { applyAgentIntegrations, resolveOnboardingOptions } from './env';

interface OnboardArgs {
  repo: string;
  yes: boolean;
  profile?: HarnessProfile;
  telemetry?: TelemetryChoice;
  control?: boolean;
  plugins?: string | false;
  skipGuide: boolean;
  skipInit: boolean;
  force: boolean;
  cursorRule?: boolean;
  agents?: string | false;
  commitGate?: 'prompt' | 'always' | 'never';
  gateMode?: 'block' | 'warn';
  gateScope?: 'worktrees' | 'all';
  /** Parallel agent slot max (1–10). */
  agentSlots?: number;
}

function parsePluginsFlag(raw: string | false | undefined): PluginId[] | undefined {
  if (raw === undefined) return undefined;
  if (raw === false) return [];
  const available = listPluginChoices().map((p) => p.id);
  if (raw.trim() === '' || raw === 'none') return [];
  const selected = raw.split(',').map((value) => value.trim()).filter(Boolean);
  const invalid = selected.filter((id) => !available.includes(id as PluginId));
  if (invalid.length > 0) {
    throw new Error(`Unknown plugin(s): ${invalid.join(', ')}. Available: ${available.join(', ')}`);
  }
  return selected as PluginId[];
}

/** Template defaults for `agentSlots.max` by harness profile. */
export function defaultAgentSlotMaxForProfile(profile: HarnessProfile): number {
  return profile === 'default' ? 5 : 3;
}

export function parseAgentSlotsFlag(raw: number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!Number.isInteger(raw) || raw < HAR_AGENT_SLOT_MIN || raw > HAR_AGENT_SLOT_ONBOARD_MAX) {
    throw new Error(
      `--agent-slots must be an integer from ${HAR_AGENT_SLOT_MIN} to ${HAR_AGENT_SLOT_ONBOARD_MAX}`,
    );
  }
  return raw;
}

function resolveDefaultAgentSlotsMax(
  repoPath: string,
  profile: HarnessProfile,
  alreadyPresent: boolean,
): number {
  if (alreadyPresent) {
    try {
      return getAgentSlotRange(repoPath).max;
    } catch {
      // fall through to profile default
    }
  }
  return defaultAgentSlotMaxForProfile(profile);
}

async function pauseForGuide(autoYes: boolean): Promise<void> {
  if (autoYes || !process.stdin.isTTY || !process.stdout.isTTY) return;
  await inquirer.prompt([
    {
      type: 'input',
      name: 'continue',
      message: 'Press Enter to continue',
    },
  ]);
}

/**
 * Mission Control needs Docker — never default to starting it when the engine
 * is unusable (an explicit `--control` still wins over this default).
 */
export function defaultStartControl(telemetry: TelemetryChoice, docker: DockerStatus): boolean {
  return telemetry !== 'off' && isDockerUsable(docker);
}

async function promptChoices(
  args: OnboardArgs,
  docker: DockerStatus,
): Promise<{
  profile: HarnessProfile;
  telemetry: TelemetryChoice;
  startControl: boolean;
  plugins: PluginId[];
  agentSlotsMax?: number;
}> {
  const flaggedSlots = parseAgentSlotsFlag(args.agentSlots);
  const shouldConfigureSlots = !args.skipInit;

  if (args.yes) {
    const telemetry = args.telemetry ?? 'on';
    return {
      profile: args.profile ?? 'default',
      telemetry,
      startControl: args.control ?? defaultStartControl(telemetry, docker),
      plugins: parsePluginsFlag(args.plugins) ?? [],
      agentSlotsMax: shouldConfigureSlots ? flaggedSlots : undefined,
    };
  }

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    if (
      args.telemetry === undefined &&
      args.control === undefined &&
      args.plugins === undefined &&
      args.profile === undefined &&
      args.agentSlots === undefined
    ) {
      throw new Error(
        'Interactive onboarding requires a TTY. Pass --yes or flags (--profile, --telemetry, --control/--no-control, --plugins, --agent-slots).',
      );
    }
    const telemetry = args.telemetry ?? 'on';
    return {
      profile: args.profile ?? 'default',
      telemetry,
      startControl: args.control ?? defaultStartControl(telemetry, docker),
      plugins: parsePluginsFlag(args.plugins) ?? [],
      agentSlotsMax: shouldConfigureSlots ? flaggedSlots : undefined,
    };
  }

  const pluginChoices = listPluginChoices();
  const repoPath = path.resolve(args.repo);
  const alreadyPresent = harnessExists(repoPath);
  const needProfile = !alreadyPresent && !args.skipInit && args.profile === undefined;
  const needAgentSlots = shouldConfigureSlots && flaggedSlots === undefined;

  if (needAgentSlots) {
    info(
      'Each parallel slot runs an isolated copy of the stack. The practical limit depends on your machine resources (RAM/CPU) and how expensive the stack is to run (Docker services, databases, frontends, etc.). You can change this later in .har/stages.json.',
    );
  }

  const answers = await inquirer.prompt<{
    profile?: HarnessProfile;
    telemetry?: TelemetryChoice;
    startControl?: boolean;
    plugins?: PluginId[];
    agentSlotsMax?: number;
  }>([
    {
      type: 'list',
      name: 'profile',
      message: 'Harness profile',
      when: () => needProfile,
      choices: [
        { name: 'default — web / full-stack apps', value: 'default' },
        { name: 'cli — libraries and CLI tools (no PM2)', value: 'cli' },
        { name: 'ios — Xcode / iOS Simulator', value: 'ios' },
      ],
      default: 'default',
    },
    {
      type: 'list',
      name: 'telemetry',
      message: 'Agent usage telemetry (Cursor / Claude / Codex → Mission Control)',
      when: () => args.telemetry === undefined,
      choices: [
        { name: 'Full on (traces, logs, metrics, prompts) — recommended', value: 'on' },
        { name: 'On without prompt text', value: 'on-no-prompts' },
        { name: 'Off', value: 'off' },
      ],
      default: 'on',
    },
    {
      type: 'confirm',
      name: 'startControl',
      message: isDockerUsable(docker)
        ? 'Start Mission Control now?'
        : 'Start Mission Control now? (needs Docker — currently unavailable)',
      when: () => args.control === undefined,
      default: (current: { telemetry?: TelemetryChoice }) =>
        defaultStartControl(args.telemetry ?? current.telemetry ?? 'on', docker),
    },
    {
      type: 'checkbox',
      name: 'plugins',
      message: 'Optional plugins to install (space to toggle, enter to confirm)',
      when: () => args.plugins === undefined,
      choices: pluginChoices.map((plugin) => ({
        name: plugin.label,
        value: plugin.id,
      })),
    },
    {
      type: 'number',
      name: 'agentSlotsMax',
      message: `How many agents do you want to run in parallel? (${HAR_AGENT_SLOT_MIN}–${HAR_AGENT_SLOT_ONBOARD_MAX})`,
      when: () => needAgentSlots,
      default: (current: { profile?: HarnessProfile }) =>
        resolveDefaultAgentSlotsMax(
          repoPath,
          args.profile ?? current.profile ?? 'default',
          alreadyPresent,
        ),
      validate: (value: number | undefined) => {
        if (
          value === undefined ||
          !Number.isInteger(value) ||
          value < HAR_AGENT_SLOT_MIN ||
          value > HAR_AGENT_SLOT_ONBOARD_MAX
        ) {
          return `Enter an integer from ${HAR_AGENT_SLOT_MIN} to ${HAR_AGENT_SLOT_ONBOARD_MAX}`;
        }
        return true;
      },
    },
  ]);

  const telemetry = args.telemetry ?? answers.telemetry ?? 'on';
  const profile = args.profile ?? answers.profile ?? 'default';
  let agentSlotsMax: number | undefined;
  if (shouldConfigureSlots) {
    agentSlotsMax = flaggedSlots ?? answers.agentSlotsMax;
  }

  return {
    profile,
    telemetry,
    startControl:
      args.control ?? answers.startControl ?? defaultStartControl(telemetry, docker),
    plugins: parsePluginsFlag(args.plugins) ?? answers.plugins ?? [],
    agentSlotsMax,
  };
}

function printSummary(result: {
  repoPath: string;
  harnessInitialized: boolean;
  harnessAlreadyPresent: boolean;
  telemetry: TelemetryChoice;
  controlStarted: boolean;
  controlApiUrl: string;
  pluginsApplied: PluginId[];
  adaptationPromptPath: string | null;
  adaptationPromptCopied: boolean;
  agentSlots: { min: number; max: number } | null;
  docker: DockerStatus;
}): void {
  divider();
  success('Onboarding complete');
  info(`Repository:     ${result.repoPath}`);
  info(
    `Harness:        ${
      result.harnessInitialized
        ? 'scaffolded'
        : result.harnessAlreadyPresent
          ? 'already present'
          : 'skipped'
    }`,
  );
  info(`Telemetry:      ${result.telemetry}`);
  info(`Docker:         ${describeDockerStatus(result.docker)}`);
  info(
    `Mission Control:${
      result.controlStarted
        ? ` started (${result.controlApiUrl})`
        : ` not started (${result.controlApiUrl})`
    }`,
  );
  info(
    `Plugins:        ${
      result.pluginsApplied.length > 0 ? result.pluginsApplied.join(', ') : 'none'
    }`,
  );
  if (result.agentSlots) {
    info(
      `Agent slots:    ${result.agentSlots.min}–${result.agentSlots.max} parallel (see .har/stages.json)`,
    );
  }
  if (result.adaptationPromptPath) {
    info(`Adapt prompt:   ${result.adaptationPromptPath}`);
    info(
      result.adaptationPromptCopied
        ? 'Clipboard:      copied — paste into your coding agent'
        : 'Clipboard:      open .har/ADAPT-PROMPT.md and paste into your coding agent',
    );
  }
  console.error('');
  console.error('  Next:');
  if (!isDockerUsable(result.docker)) {
    console.error('    Docker:  install / start Docker — required for Mission Control and harness infra');
  }
  console.error('    Adapt:   paste the prompt into your coding agent');
  console.error('    Launch:  har env launch 1');
  console.error('    Verify:  har env verify 1 --full');
  console.error('    Control: har control up   # if you skipped Mission Control');
  console.error('');
}

export async function handleOnboard(argv: OnboardArgs): Promise<void> {
  const repoPath = path.resolve(argv.repo);
  header('har onboard');
  info(`Repository: ${repoPath}`);

  try {
    if (!argv.skipGuide) {
      printOnboardingGuide();
      await pauseForGuide(argv.yes);
    } else {
      info(`Skipped guide (${ONBOARDING_GUIDE_STEPS.length} steps available without --skip-guide)`);
    }

    const docker = detectDockerStatus();
    warnIfDockerUnavailable(docker);

    const choices = await promptChoices(argv, docker);
    const onboarding = resolveOnboardingOptions(argv);

    const result = await runOnboarding({
      repoPath,
      docker,
      profile: choices.profile,
      telemetry: choices.telemetry,
      startControl: choices.startControl,
      plugins: choices.plugins,
      skipInit: argv.skipInit,
      deferAdaptationPrompt: true,
      autoYes: argv.yes,
      forcePlugins: argv.force,
      agentSlotsMax: choices.agentSlotsMax,
    });

    if (result.harnessInitialized || harnessExists(repoPath)) {
      await handleCommitGateOnboarding({
        repoPath,
        ...onboarding.commitGate,
        autoYes: argv.yes,
      });
      await applyAgentIntegrations({
        repoPath,
        mode: result.harnessInitialized ? 'init' : 'maintain',
        autoYes: argv.yes,
        force: argv.force,
        cursorRule: onboarding.cursorRule,
        ...onboarding.agentSkills,
      });
    }

    if (harnessExists(repoPath)) {
      const finalized = await finalizeOnboardingAdaptation({
        repoPath,
        profile: result.profile,
        harnessInitialized: result.harnessInitialized,
        autoYes: argv.yes,
      });
      result.adaptationPromptPath = finalized.path;
      result.adaptationPromptCopied = finalized.copied;
    }

    for (const warning of result.pluginWarnings) {
      warn(warning);
    }

    printSummary(result);
  } catch (err: unknown) {
    error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export const onboardCommand = {
  command: 'onboard',
  describe:
    'Interactive first-run guide: how HAR works, telemetry, Mission Control, plugins, adapt prompt',
  builder: (yargs: Argv) =>
    yargs
      .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
      .option('yes', {
        alias: 'y',
        type: 'boolean',
        default: false,
        describe:
          'Accept defaults without prompting (telemetry on, start Mission Control when Docker is available, no plugins)',
      })
      .option('profile', {
        type: 'string',
        choices: ['default', 'cli', 'ios'] as const,
        describe: 'Harness profile when scaffolding (default: default)',
      })
      .option('telemetry', {
        type: 'string',
        choices: ['on', 'on-no-prompts', 'off'] as const,
        describe: 'Telemetry preference',
      })
      .option('control', {
        type: 'boolean',
        describe: 'Start Mission Control — requires Docker (use --no-control to skip)',
      })
      .option('plugins', {
        type: 'string',
        describe:
          'Comma-separated plugins to install (e.g. playwright); --no-plugins to skip; interactive checkbox when omitted',
      })
      .option('agent-slots', {
        type: 'number',
        describe: `Max parallel agent slots to configure in .har/stages.json (${HAR_AGENT_SLOT_MIN}–${HAR_AGENT_SLOT_ONBOARD_MAX})`,
      })
      .option('skip-guide', {
        type: 'boolean',
        default: false,
        describe: 'Skip the how-HAR-works introduction',
      })
      .option('skip-init', {
        type: 'boolean',
        default: false,
        describe: 'Do not scaffold .har/ even when missing',
      })
      .option('force', {
        type: 'boolean',
        default: false,
        describe: 'Overwrite existing plugin files when installing',
      })
      .option('cursor-rule', {
        type: 'boolean',
        describe:
          'Create .cursor/rules/har-workflow.mdc without prompting (use --no-cursor-rule to skip)',
      })
      .option('agents', {
        type: 'string',
        describe:
          'Scaffold agent skills for these targets (comma-separated: claude,cursor,codex); --no-agents to skip',
      })
      .option('commit-gate', {
        choices: ['prompt', 'always', 'never'] as const,
        describe: 'Install commit hooks during onboarding (defaults to user preferences)',
      })
      .option('gate-mode', {
        choices: ['block', 'warn'] as const,
        describe: 'Policy for commits without a passing full verification',
      })
      .option('gate-scope', {
        choices: ['worktrees', 'all'] as const,
        describe: 'Apply the commit policy to HAR worktrees or every checkout',
      }),
  handler: (argv: OnboardArgs) => handleOnboard(argv),
};
