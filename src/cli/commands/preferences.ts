import inquirer from 'inquirer';
import type { Argv } from 'yargs';
import {
  OnboardingPreferenceOverrides,
  getOnboardingPreferencesPath,
  readOnboardingPreferences,
  writeOnboardingPreferences,
} from '../../core/onboarding-preferences';
import { AgentSkillTarget } from '../../harness/schema';
import { header, info, success } from '../../utils/logging';

interface ConfigureArgs {
  cursorRule?: 'auto' | 'on' | 'off';
  agents?: string;
  commitGate?: 'prompt' | 'always' | 'never';
  gateMode?: 'block' | 'warn';
  gateScope?: 'worktrees' | 'all';
}

function parseAgents(raw: string): 'auto' | AgentSkillTarget[] {
  if (raw === 'auto') return 'auto';
  if (raw === 'none') return [];
  const valid: AgentSkillTarget[] = ['claude', 'cursor', 'codex'];
  const selected = raw.split(',').map((value) => value.trim().toLowerCase());
  const invalid = selected.filter((value) => !valid.includes(value as AgentSkillTarget));
  if (invalid.length > 0) {
    throw new Error(`Unknown agent target(s): ${invalid.join(', ')}. Valid: auto, none, ${valid.join(',')}`);
  }
  return valid.filter((value) => selected.includes(value));
}

function printPreferences(json: boolean): void {
  const preferences = readOnboardingPreferences();
  if (json) {
    process.stdout.write(`${JSON.stringify({ path: getOnboardingPreferencesPath(), ...preferences }, null, 2)}\n`);
    return;
  }
  header('har preferences');
  info(`File:          ${getOnboardingPreferencesPath()}`);
  info(`Cursor rule:   ${preferences.cursorRule}`);
  info(
    `Agent skills:  ${preferences.agentSkills === 'auto' ? 'auto' : preferences.agentSkills.join(',') || 'none'}`,
  );
  info(
    `Commit gate:   install=${preferences.commitGate.install} mode=${preferences.commitGate.mode} scope=${preferences.commitGate.scope}`,
  );
}

async function promptOverrides(): Promise<OnboardingPreferenceOverrides> {
  const current = readOnboardingPreferences();
  const answers = await inquirer.prompt<{
    cursorRule: 'auto' | 'on' | 'off';
    agentSkills: AgentSkillTarget[];
    commitGateInstall: 'prompt' | 'always' | 'never';
    commitGateMode: 'block' | 'warn';
    commitGateScope: 'worktrees' | 'all';
  }>([
    {
      type: 'list',
      name: 'cursorRule',
      message: 'Cursor workflow rule',
      choices: [
        { name: 'Auto-detect', value: 'auto' },
        { name: 'Always install', value: 'on' },
        { name: 'Never install', value: 'off' },
      ],
      default: current.cursorRule,
    },
    {
      type: 'checkbox',
      name: 'agentSkills',
      message: 'Agent integrations (leave empty for none)',
      choices: ['claude', 'cursor', 'codex'],
      default: current.agentSkills === 'auto' ? [] : current.agentSkills,
    },
    {
      type: 'list',
      name: 'commitGateInstall',
      message: 'Install the commit gate during onboarding',
      choices: [
        { name: 'Ask per repository', value: 'prompt' },
        { name: 'Always', value: 'always' },
        { name: 'Never', value: 'never' },
      ],
      default: current.commitGate.install,
    },
    {
      type: 'list',
      name: 'commitGateMode',
      message: 'Unverified commit policy',
      choices: ['block', 'warn'],
      default: current.commitGate.mode,
    },
    {
      type: 'list',
      name: 'commitGateScope',
      message: 'Commit gate scope',
      choices: ['worktrees', 'all'],
      default: current.commitGate.scope,
    },
  ]);
  return answers;
}

async function handleConfigure(argv: ConfigureArgs): Promise<void> {
  const hasFlags =
    argv.cursorRule !== undefined ||
    argv.agents !== undefined ||
    argv.commitGate !== undefined ||
    argv.gateMode !== undefined ||
    argv.gateScope !== undefined;
  if (!hasFlags && (!process.stdin.isTTY || !process.stdout.isTTY)) {
    throw new Error('Interactive preferences require a TTY; pass configuration flags instead.');
  }
  const overrides = hasFlags
    ? {
        cursorRule: argv.cursorRule,
        agentSkills: argv.agents === undefined ? undefined : parseAgents(argv.agents),
        commitGateInstall: argv.commitGate,
        commitGateMode: argv.gateMode,
        commitGateScope: argv.gateScope,
      }
    : await promptOverrides();
  writeOnboardingPreferences(overrides);
  success(`Saved onboarding defaults to ${getOnboardingPreferencesPath()}`);
  printPreferences(false);
}

export const preferencesCommand = {
  command: 'preferences <subcommand>',
  describe: 'Configure user defaults for HAR repository onboarding',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'show',
        'Show onboarding preferences',
        (y: Argv) => y.option('json', { type: 'boolean', default: false }),
        (argv: { json: boolean }) => printPreferences(argv.json),
      )
      .command(
        'configure',
        'Select onboarding defaults interactively or with flags',
        (y: Argv) =>
          y
            .option('cursor-rule', { choices: ['auto', 'on', 'off'] as const })
            .option('agents', {
              type: 'string',
              describe: 'auto, none, or comma-separated claude,cursor,codex',
            })
            .option('commit-gate', { choices: ['prompt', 'always', 'never'] as const })
            .option('gate-mode', { choices: ['block', 'warn'] as const })
            .option('gate-scope', { choices: ['worktrees', 'all'] as const }),
        handleConfigure,
      )
      .demandCommand(1, 'Specify a subcommand: show or configure'),
  handler: () => {},
};
