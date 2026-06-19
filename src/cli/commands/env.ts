import * as path from 'path';
import type { Argv } from 'yargs';
import { initHarness, maintainHarness } from '../../core/harness';
import { promptApplyAgentMdProposal, readAgentMdProposal, clearAgentMdProposal } from '../../harness/agent-md';
import {
  getEnvironmentStatus,
  launchEnvironment,
  runVerification,
  teardownEnvironment,
} from '../../core/run-service';
import { writeFileSafe } from '../../utils/file-ops';
import { requireApiKey, validateAgentId } from '../../utils/validation';
import { info, success, error, header, divider, warn } from '../../utils/logging';

export const envCommand = {
  command: 'env <subcommand>',
  describe: 'Manage agent environments',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'init',
        'Copy harness boilerplate into .har/ and adapt it to the repository with Claude',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('verbose', { alias: 'v', type: 'boolean', default: false })
            .option('model', { type: 'string', describe: 'Claude model for authoring' })
            .option('force', { type: 'boolean', default: false, describe: 'Overwrite existing .har/' })
            .option('smoke', { type: 'boolean', default: false, describe: 'Run setup-infra.sh after adaptation' })
            .option('skip-llm', { type: 'boolean', default: false, describe: 'Copy boilerplate only' })
            .option('yes', { type: 'boolean', default: false, describe: 'Auto-apply AGENT.md proposal without prompting' }),
        handleInit,
      )
      .command(
        'maintain',
        'Update .har/ to reflect current repository changes',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', default: '.' })
            .option('verbose', { alias: 'v', type: 'boolean', default: false })
            .option('model', { type: 'string' })
            .option('yes', { type: 'boolean', default: false, describe: 'Auto-apply AGENT.md proposal' }),
        handleMaintain,
      )
      .command(
        'launch <id>',
        'Launch an agent environment slot',
        (y: Argv) =>
          y
            .positional('id', { type: 'number', describe: 'Agent slot id (see .har/stages.json agentSlots)' })
            .option('repo', { type: 'string', default: '.' })
            .option('worktree', { type: 'boolean', default: false })
            .option('claude', { type: 'boolean', default: false }),
        handleLaunch,
      )
      .command(
        'verify <id>',
        'Run verification suite for an agent',
        (y: Argv) =>
          y
            .positional('id', { type: 'number', describe: 'Agent slot id (see .har/stages.json agentSlots)' })
            .option('repo', { type: 'string', default: '.' })
            .option('full', { type: 'boolean', default: false }),
        handleVerify,
      )
      .command(
        'teardown <id>',
        'Tear down an agent environment',
        (y: Argv) =>
          y
            .positional('id', { type: 'number', describe: 'Agent slot id (see .har/stages.json agentSlots)' })
            .option('repo', { type: 'string', default: '.' }),
        handleTeardown,
      )
      .command(
        'status',
        'Show status of all running agents',
        (y: Argv) => y.option('repo', { type: 'string', default: '.' }),
        handleStatus,
      )
      .demandCommand(1, 'Please specify a subcommand: init, maintain, launch, verify, teardown, status'),
  handler: () => {},
};

export async function handleInit(argv: {
  repo: string;
  verbose: boolean;
  model?: string;
  force: boolean;
  smoke: boolean;
  skipLlm: boolean;
  yes: boolean;
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);

  header('har env init');
  info(`Repository: ${repoPath}`);

  try {
    if (!argv.skipLlm) {
      requireApiKey();
      divider();
      info('Adapting .har/ with Claude. This takes 1-3 minutes...');
      divider();
    }

    const result = await initHarness({
      repoPath,
      force: argv.force,
      skipLlm: argv.skipLlm,
      verbose: argv.verbose,
      model: argv.model,
      smoke: argv.smoke,
    });

    divider();
    info('Validating harness...');
    printValidation(result.validation);

    if (result.smoke) {
      printValidation(result.smoke);
      if (!result.smoke.pass) process.exit(1);
    }

    if (!result.validation.pass) {
      warn('Harness has validation errors — review .har/ and fix manually.');
      process.exit(1);
    }

    await handleAgentMdProposal(repoPath, argv.yes);

    divider();
    success('Harness initialized!');
    printNextSteps();
  } catch (err: unknown) {
    error((err as Error).message);
    process.exit(1);
  }
}

export async function handleMaintain(argv: {
  repo: string;
  verbose: boolean;
  model?: string;
  yes: boolean;
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);

  header('har env maintain');
  info('Updating .har/ harness');

  try {
    requireApiKey();

    divider();
    info('Inspecting repo and updating harness files + README...');
    divider();

    const result = await maintainHarness({
      repoPath,
      verbose: argv.verbose,
      model: argv.model,
    });

    divider();
    info('Validating updated harness...');
    printValidation(result.validation);

    if (!result.validation.pass) {
      warn('Harness has validation errors after maintenance.');
      process.exit(1);
    }

    await handleAgentMdProposal(repoPath, argv.yes);

    divider();
    success('Harness updated!');
  } catch (err: unknown) {
    error((err as Error).message);
    process.exit(1);
  }
}

async function handleAgentMdProposal(repoPath: string, autoYes: boolean): Promise<void> {
  if (autoYes) {
    const proposal = readAgentMdProposal(repoPath);
    if (proposal) {
      writeFileSafe(path.join(repoPath, 'AGENT.md'), proposal.content);
      clearAgentMdProposal(repoPath);
      info('Applied AGENT.md proposal (--yes)');
    }
    return;
  }
  await promptApplyAgentMdProposal(repoPath);
}

export async function handleLaunch(argv: {
  id?: number;
  repo: string;
  worktree: boolean;
  claude: boolean;
}): Promise<void> {
  const repo = path.resolve(argv.repo);
  const agentId = validateAgentId(argv.id, repo);
  const result = await launchEnvironment({
    repoPath: repo,
    agentId,
    worktree: argv.worktree,
    claude: argv.claude,
    capture: false,
  });
  process.exit(result.code);
}

export async function handleVerify(argv: { id?: number; repo: string; full: boolean }): Promise<void> {
  const repo = path.resolve(argv.repo);
  const agentId = validateAgentId(argv.id, repo);
  const result = await runVerification({
    repoPath: repo,
    agentId,
    full: argv.full,
    capture: false,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.code);
}

export async function handleTeardown(argv: { id?: number; repo: string }): Promise<void> {
  const repo = path.resolve(argv.repo);
  const agentId = validateAgentId(argv.id, repo);
  const result = await teardownEnvironment({
    repoPath: repo,
    agentId,
    capture: false,
  });
  process.exit(result.code);
}

export async function handleStatus(argv: { repo: string }): Promise<void> {
  await getEnvironmentStatus({
    repoPath: path.resolve(argv.repo),
    capture: false,
  });
}

function printValidation(result: {
  pass: boolean;
  issues: { file: string; message: string; severity: string }[];
}): void {
  for (const issue of result.issues) {
    const prefix = issue.severity === 'error' ? '✗' : '⚠';
    warn(`  ${prefix} ${issue.file}: ${issue.message}`);
  }
  if (result.pass && result.issues.length === 0) {
    success('  All checks passed');
  }
}

function printNextSteps(): void {
  console.error('');
  console.error('  Read:         .har/README.md');
  console.error('  Agent guide:  AGENT.md (repo root, if applied)');
  console.error('  Setup infra:  ./.har/setup-infra.sh');
  console.error('  Launch:       ./.har/launch.sh 1');
  console.error('  Verify:       ./.har/verify.sh 1');
  console.error('  Maintain:     har env maintain');
  console.error('  MCP server:   har mcp');
  console.error('');
}
