import * as path from 'path';
import type { Argv } from 'yargs';
import {
  AGENT_SKILL_TARGETS,
  detectAgentTargets,
  parseAgentTargets,
  removeAgentSkills,
  scaffoldAgentSkills,
} from '../../harness/agent-skills';
import { error, header, info, success, warn } from '../../utils/logging';

const targetsOption = (y: Argv) =>
  y
    .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
    .option('claude', { type: 'boolean', default: false, describe: 'Target Claude Code (.claude/skills/)' })
    .option('cursor', { type: 'boolean', default: false, describe: 'Target Cursor (.cursor/commands/)' })
    .option('codex', { type: 'boolean', default: false, describe: 'Target Codex CLI (~/.codex/prompts/, global)' })
    .option('agents', {
      type: 'string',
      describe: `Comma-separated targets (${AGENT_SKILL_TARGETS.join(',')}); alternative to the per-agent flags`,
    });

interface TargetsArgv {
  repo: string;
  claude: boolean;
  cursor: boolean;
  codex: boolean;
  agents?: string;
  force?: boolean;
}

function resolveTargets(argv: TargetsArgv, repoPath: string): ReturnType<typeof parseAgentTargets> {
  if (argv.agents) return parseAgentTargets(argv.agents);
  const flagged = AGENT_SKILL_TARGETS.filter((agent) => argv[agent]);
  if (flagged.length > 0) return flagged;
  return detectAgentTargets(repoPath);
}

export const agentsCommand = {
  command: 'agents <subcommand>',
  describe: 'Manage scaffolded agent skills (/setup-har, /har-wt, /har-maintain)',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'install',
        'Scaffold agent skills into this repo (Claude/Cursor) and globally (Codex)',
        (y: Argv) =>
          targetsOption(y).option('force', {
            type: 'boolean',
            default: false,
            describe: 'Overwrite files that have user modifications',
          }),
        handleInstall,
      )
      .command('remove', 'Remove har-managed agent skill files', targetsOption, handleRemove)
      .demandCommand(1, 'Specify a subcommand: install | remove'),
  handler: () => {},
};

function handleInstall(argv: TargetsArgv): void {
  const repoPath = path.resolve(argv.repo);
  header('har agents install');

  try {
    const targets = resolveTargets(argv, repoPath);
    if (targets.length === 0) {
      warn('No agent targets detected. Pass --claude, --cursor, --codex, or --agents=…');
      process.exit(1);
    }

    const result = scaffoldAgentSkills(repoPath, targets, { force: argv.force });
    for (const file of result.written) {
      info(`  + ${file}`);
    }
    if (result.written.length === 0 && result.skipped.length > 0) {
      warn('Nothing written — all target files have user modifications (use --force).');
      process.exit(1);
    }
    success(`Agent skills installed for: ${targets.join(', ')}`);
    if (targets.includes('codex')) {
      info('Codex prompts are global (~/.codex/prompts/) — Codex has no per-repo prompt support.');
    }
  } catch (err: unknown) {
    error((err as Error).message);
    process.exit(1);
  }
}

function handleRemove(argv: TargetsArgv): void {
  const repoPath = path.resolve(argv.repo);
  header('har agents remove');

  try {
    const targets = resolveTargets(argv, repoPath);
    if (targets.length === 0) {
      warn('No agent targets detected or specified.');
      return;
    }
    const removed = removeAgentSkills(repoPath, targets);
    for (const file of removed) {
      info(`  - ${file}`);
    }
    success(removed.length > 0 ? 'Agent skills removed.' : 'Nothing to remove.');
  } catch (err: unknown) {
    error((err as Error).message);
    process.exit(1);
  }
}
