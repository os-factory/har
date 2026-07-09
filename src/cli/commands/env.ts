import * as path from 'path';
import type { Argv } from 'yargs';
import { initHarness, maintainHarness, addStageTemplate } from '../../core/harness';
import { HarnessDriftResult } from '../../harness/drift';
import {
  buildInitAdaptationPrompt,
  buildMaintainAdaptationPrompt,
  printAdaptationPrompt,
  writeAdaptationPrompt,
} from '../../harness/adaptation-prompt';
import { promptApplyAgentMdProposal, readAgentMdProposal, clearAgentMdProposal } from '../../harness/agent-md';
import { handleCursorRule } from '../../harness/cursor-rule';
import {
  completeEnvironment,
  getEnvironmentStatus,
  launchEnvironment,
  preflightEnvironment,
  runVerification,
  teardownEnvironment,
} from '../../core/run-service';
import { checkLaunchGuard } from '../../core/slot-launch-guard';
import { listRuns, getRun } from '../../core/runs';
import { collectEnvironmentStatus } from '../../core/slot-status';
import { EnvironmentStatusSchema, SlotReadinessSchema } from '../../harness/schema';
import { recordRepoForControlSync } from '../../core/control-registry';
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
        'Copy harness boilerplate into .har/ (use --auto for built-in Claude adaptation)',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('verbose', { alias: 'v', type: 'boolean', default: false })
            .option('model', { type: 'string', describe: 'Claude model for authoring (--auto only)' })
            .option('force', { type: 'boolean', default: false, describe: 'Overwrite existing .har/' })
            .option('smoke', { type: 'boolean', default: false, describe: 'Run setup-infra.sh after adaptation' })
            .option('auto', {
              type: 'boolean',
              default: false,
              describe: 'Run built-in Claude adaptation (requires ANTHROPIC_API_KEY)',
            })
            .option('profile', {
              type: 'string',
              choices: ['default', 'cli', 'ios'] as const,
              default: 'default' as const,
              describe: 'Boilerplate profile: default (web app), cli (library/CLI, no PM2), ios (iOS mobile app)',
            })
            .option('yes', {
              type: 'boolean',
              default: false,
              describe: 'Auto-apply AGENT.md proposal without prompting (--auto only)',
            })
            .option('cursor-rule', {
              type: 'boolean',
              default: false,
              describe: 'Create .cursor/rules/har-workflow.mdc without prompting',
            })
            .option('no-cursor-rule', {
              type: 'boolean',
              default: false,
              describe: 'Skip Cursor rule scaffolding',
            }),
        handleInit,
      )
      .command(
        'maintain',
        'Validate .har/ and print a maintenance prompt (use --auto for built-in Claude adaptation)',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', default: '.' })
            .option('verbose', { alias: 'v', type: 'boolean', default: false })
            .option('model', { type: 'string', describe: 'Claude model for authoring (--auto only)' })
            .option('auto', {
              type: 'boolean',
              default: false,
              describe: 'Run built-in Claude adaptation (requires ANTHROPIC_API_KEY)',
            })
            .option('yes', { type: 'boolean', default: false, describe: 'Auto-apply AGENT.md proposal (--auto only)' })
            .option('finalize', {
              type: 'boolean',
              default: false,
              describe: 'Record the completed manual adaptation in .har/manifest.json (updates generatorVersion and checksums)',
            })
            .option('summary', {
              type: 'string',
              describe: 'Adaptation summary to store in the manifest (--finalize only)',
            })
            .option('cursor-rule', {
              type: 'boolean',
              default: false,
              describe: 'Create .cursor/rules/har-workflow.mdc without prompting',
            })
            .option('no-cursor-rule', {
              type: 'boolean',
              default: false,
              describe: 'Skip Cursor rule scaffolding',
            }),
        handleMaintain,
      )
      .command(
        'add-stage <template>',
        'Add an optional stage template (e.g. playwright)',
        (y: Argv) =>
          y
            .positional('template', {
              type: 'string',
              describe: 'Stage template id (playwright)',
            })
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('force', {
              type: 'boolean',
              default: false,
              describe: 'Overwrite existing template files and stage entry',
            })
            .option('skip-ci', {
              type: 'boolean',
              default: false,
              describe: 'Do not copy .github/workflows/playwright.yml',
            }),
        handleAddStage,
      )
      .command(
        'launch <id>',
        'Launch a fresh agent session (replaces any previous session for the slot)',
        (y: Argv) =>
          y
            .positional('id', { type: 'number', describe: 'Agent slot id (see .har/stages.json agentSlots)' })
            .option('repo', { type: 'string', default: '.' })
            .option('worktree', {
              type: 'boolean',
              default: true,
              describe: 'Use an isolated git worktree (default)',
            })
            .option('claude', { type: 'boolean', default: false })
            .option('replace', {
              type: 'boolean',
              default: false,
              describe: 'Replace an occupied slot (prompts on TTY when omitted)',
            })
            .option('force', {
              type: 'boolean',
              default: false,
              describe:
                'Discard uncommitted changes when replacing a dirty worktree (only after explicit approval)',
            }),
        handleLaunch,
      )
      .command(
        'preflight <id>',
        'Check whether a slot can launch now (ports, PM2, Docker, occupied slot)',
        (y: Argv) =>
          y
            .positional('id', { type: 'number', describe: 'Agent slot id (see .har/stages.json agentSlots)' })
            .option('repo', { type: 'string', default: '.' })
            .option('json', { type: 'boolean', default: false, describe: 'Structured JSON output' })
            .option('replace', {
              type: 'boolean',
              default: false,
              describe: 'Treat an occupied slot as replaceable (same as launch --replace)',
            })
            .option('force', {
              type: 'boolean',
              default: false,
              describe: 'Allow replacing a dirty worktree (only after explicit approval)',
            }),
        handlePreflight,
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
        'Tear down an agent environment (keeps the session branch)',
        (y: Argv) =>
          y
            .positional('id', { type: 'number', describe: 'Agent slot id (see .har/stages.json agentSlots)' })
            .option('repo', { type: 'string', default: '.' })
            .option('delete-branch', {
              type: 'boolean',
              default: false,
              describe: 'Also delete the session git branch',
            }),
        handleTeardown,
      )
      .command(
        'complete <id>',
        'Finish a session: full verify (recorded as validation), teardown, keep the branch for a PR',
        (y: Argv) =>
          y
            .positional('id', { type: 'number', describe: 'Agent slot id (see .har/stages.json agentSlots)' })
            .option('repo', { type: 'string', default: '.' })
            .option('skip-verify', {
              type: 'boolean',
              default: false,
              describe: 'Tear down without running verification (no validation is recorded)',
            }),
        handleComplete,
      )
      .command(
        'status',
        'Show status of all running agents',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', default: '.' })
            .option('json', { type: 'boolean', default: false, describe: 'Structured JSON output' }),
        handleStatus,
      )
      .command(
        'runs',
        'Inspect harness run history',
        (y: Argv) =>
          y
            .command(
              'list',
              'List harness runs',
              (y2: Argv) =>
                y2
                  .option('repo', { type: 'string', default: '.' })
                  .option('stage', { type: 'string', describe: 'Filter by stage id' })
                  .option('limit', { type: 'number', default: 50 })
                  .option('json', { type: 'boolean', default: false }),
              handleRunsList,
            )
            .command(
              'get <runId>',
              'Get one harness run by id',
              (y2: Argv) =>
                y2
                  .positional('runId', { type: 'string', describe: 'Run UUID' })
                  .option('repo', { type: 'string', default: '.' })
                  .option('json', { type: 'boolean', default: true }),
              (argv) =>
                handleRunsGet({
                  repo: argv.repo as string,
                  runId: argv.runId as string,
                  json: argv.json as boolean,
                }),
            )
            .demandCommand(1, 'Use: runs list | runs get <runId>'),
        () => {},
      )
      .demandCommand(1, 'Please specify a subcommand: init, maintain, add-stage, launch, verify, complete, teardown, status, runs'),
  handler: () => {},
};

export async function handleInit(argv: {
  repo: string;
  verbose: boolean;
  model?: string;
  force: boolean;
  smoke: boolean;
  auto: boolean;
  yes: boolean;
  profile: 'default' | 'cli' | 'ios';
  cursorRule: boolean;
  noCursorRule: boolean;
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);

  header('har env init');
  info(`Repository: ${repoPath}`);

  try {
    if (argv.auto) {
      requireApiKey();
      divider();
      info('Adapting .har/ with Claude. This takes 1-3 minutes...');
      divider();
    }

    const result = await initHarness({
      repoPath,
      force: argv.force,
      auto: argv.auto,
      verbose: argv.verbose,
      model: argv.model,
      smoke: argv.smoke,
      profile: argv.profile,
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

    if (argv.auto) {
      await handleAgentMdProposal(repoPath, argv.yes);
    } else {
      emitManualAdaptationPrompt(repoPath, 'init', argv.profile);
    }

    divider();
    success('Harness initialized!');
    recordRepoForControlSync(repoPath);
    await handleCursorRule({
      repoPath,
      cursorRule: resolveCursorRuleFlag(argv.cursorRule, argv.noCursorRule),
      autoYes: argv.yes,
      mode: 'init',
    });
    printNextSteps(argv.auto);
  } catch (err: unknown) {
    error((err as Error).message);
    process.exit(1);
  }
}

export async function handleMaintain(argv: {
  repo: string;
  verbose: boolean;
  model?: string;
  auto: boolean;
  yes: boolean;
  finalize: boolean;
  summary?: string;
  cursorRule: boolean;
  noCursorRule: boolean;
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);

  header('har env maintain');
  info(`Repository: ${repoPath}`);

  try {
    if (argv.auto) {
      requireApiKey();
      divider();
      info('Inspecting repo and updating harness files + README...');
      divider();
    }

    const result = await maintainHarness({
      repoPath,
      auto: argv.auto,
      verbose: argv.verbose,
      model: argv.model,
      finalize: argv.finalize,
      summary: argv.summary,
    });

    divider();
    info('Validating harness...');
    printValidation(result.validation);
    printDrift(result.drift);

    if (!result.validation.pass) {
      warn('Harness has validation errors after maintenance.');
      process.exit(1);
    }

    if (argv.auto) {
      await handleAgentMdProposal(repoPath, argv.yes);
    } else if (argv.finalize) {
      info('Manifest updated — generator version and file checksums recorded.');
    } else {
      emitManualAdaptationPrompt(repoPath, 'maintain');
      info('After your coding agent finishes adapting, record it with: har env maintain --finalize');
    }

    divider();
    success('Harness updated!');
    await handleCursorRule({
      repoPath,
      cursorRule: resolveCursorRuleFlag(argv.cursorRule, argv.noCursorRule),
      autoYes: argv.yes,
      mode: 'maintain',
    });
  } catch (err: unknown) {
    error((err as Error).message);
    process.exit(1);
  }
}

function resolveCursorRuleFlag(cursorRule: boolean, noCursorRule: boolean): boolean | undefined {
  if (noCursorRule) return false;
  if (cursorRule) return true;
  return undefined;
}

function emitManualAdaptationPrompt(
  repoPath: string,
  mode: 'init' | 'maintain',
  profile: 'default' | 'cli' | 'ios' = 'default',
): void {
  const prompt =
    mode === 'init'
      ? buildInitAdaptationPrompt(repoPath, profile)
      : buildMaintainAdaptationPrompt(repoPath);

  writeAdaptationPrompt(repoPath, prompt);

  process.stderr.write('\n');
  if (mode === 'init') {
    info('Harness scaffolded. Adapt it with your coding agent:');
  } else {
    info('Review harness drift with your coding agent:');
  }
  info('  Paste the prompt below (also saved to .har/ADAPT-PROMPT.md)');
  info('  TODO validation warnings are expected until adaptation is complete.');
  printAdaptationPrompt(prompt);
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

export async function handleAddStage(argv: {
  template?: string;
  repo: string;
  force: boolean;
  skipCi: boolean;
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);

  if (argv.template !== 'playwright') {
    error(`Unknown stage template: ${argv.template ?? '(missing)'}. Available: playwright`);
    process.exit(1);
  }

  header('har env add-stage');
  info(`Repository: ${repoPath}`);
  info(`Template: ${argv.template}`);

  try {
    const result = addStageTemplate(repoPath, 'playwright', {
      force: argv.force,
      skipCi: argv.skipCi,
    });

    divider();
    success(`Stage template applied: ${result.stageId}`);
    console.error('');
    console.error('  Next steps:');
    for (const step of result.nextSteps) {
      console.error(`    ${step}`);
    }
    console.error('');
    console.error('  Docs: .har/stages/PLAYWRIGHT.md');
    console.error('');
  } catch (err: unknown) {
    error((err as Error).message);
    process.exit(1);
  }
}

export async function handlePreflight(argv: {
  id?: number;
  repo: string;
  json?: boolean;
  replace: boolean;
  force: boolean;
}): Promise<void> {
  const repo = path.resolve(argv.repo);
  const agentId = validateAgentId(argv.id, repo);
  const result = await preflightEnvironment({
    repoPath: repo,
    agentId,
    confirmReplace: argv.replace,
    force: argv.force,
  });

  if (argv.json) {
    const output = SlotReadinessSchema.parse(result.readiness);
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    process.exit(result.code);
    return;
  }

  if (result.stdout) process.stdout.write(result.stdout);
  process.exit(result.code);
}

export async function handleLaunch(argv: {
  id?: number;
  repo: string;
  worktree: boolean;
  claude: boolean;
  replace: boolean;
  force: boolean;
}): Promise<void> {
  const repo = path.resolve(argv.repo);
  const agentId = validateAgentId(argv.id, repo);

  let confirmReplace = argv.replace;
  let force = argv.force;

  const guard = checkLaunchGuard(repo, agentId, { confirmReplace, force });
  if (!guard.allowed && guard.blocked) {
    if (!confirmReplace && process.stdin.isTTY && process.stdout.isTTY) {
      warn('Occupied slot — review before replacing:');
      console.error(guard.reason ?? '');
      const readline = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const answer = await new Promise<string>((resolve) => {
        rl.question('Replace this slot? [y/N] ', resolve);
      });
      rl.close();
      if (!/^[Yy]$/.test(answer.trim())) {
        error('Aborted — slot left unchanged.');
        process.exit(2);
      }
      confirmReplace = true;
    }
  }

  const guardAfterConfirm = checkLaunchGuard(repo, agentId, { confirmReplace, force });
  if (!guardAfterConfirm.allowed && guardAfterConfirm.blocked && guardAfterConfirm.slot?.dirty) {
    if (!force && process.stdin.isTTY && process.stdout.isTTY) {
      warn('Worktree has uncommitted changes.');
      const readline = await import('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const answer = await new Promise<string>((resolve) => {
        rl.question('Discard uncommitted changes? [y/N] ', resolve);
      });
      rl.close();
      if (!/^[Yy]$/.test(answer.trim())) {
        error('Aborted — uncommitted work preserved.');
        process.exit(2);
      }
      force = true;
    } else if (!force) {
      error(guardAfterConfirm.reason ?? 'Dirty worktree requires --force.');
      process.exit(2);
    }
  }

  const result = await launchEnvironment({
    repoPath: repo,
    agentId,
    worktree: argv.worktree,
    claude: argv.claude,
    confirmReplace,
    force,
    capture: false,
  });
  if (result.blocked) {
    error(result.stderr || 'Launch blocked: slot is occupied.');
    process.exit(result.code || 2);
  }
  if (result.code === 0 && result.workDir) {
    divider();
    success(`Session ready — make ALL file edits under: ${result.workDir}`);
    if (result.branch) info(`Branch: ${result.branch}`);
  }
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

export async function handleTeardown(argv: {
  id?: number;
  repo: string;
  deleteBranch: boolean;
}): Promise<void> {
  const repo = path.resolve(argv.repo);
  const agentId = validateAgentId(argv.id, repo);
  const result = await teardownEnvironment({
    repoPath: repo,
    agentId,
    deleteBranch: argv.deleteBranch,
    capture: false,
  });
  process.exit(result.code);
}

export async function handleComplete(argv: {
  id?: number;
  repo: string;
  skipVerify: boolean;
}): Promise<void> {
  const repo = path.resolve(argv.repo);
  const agentId = validateAgentId(argv.id, repo);
  const result = await completeEnvironment({
    repoPath: repo,
    agentId,
    skipVerify: argv.skipVerify,
    capture: false,
  });
  if (result.code === 0) {
    divider();
    success('Session completed.');
    if (result.branch) {
      info(`Branch kept: ${result.branch}`);
      info(`Push it with: git push -u origin ${result.branch}`);
    }
  } else if (result.stderr) {
    error(result.stderr.trim());
  }
  process.exit(result.code);
}

export async function handleStatus(argv: { repo: string; json?: boolean }): Promise<void> {
  const repoPath = path.resolve(argv.repo);

  if (argv.json) {
    const status = collectEnvironmentStatus(repoPath);
    const output = EnvironmentStatusSchema.parse(status);
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }

  await getEnvironmentStatus({
    repoPath,
    capture: false,
  });
}

export async function handleRunsList(argv: {
  repo: string;
  stage?: string;
  limit: number;
  json?: boolean;
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);
  const runs = listRuns(repoPath, { stageId: argv.stage, limit: argv.limit });

  if (argv.json) {
    process.stdout.write(JSON.stringify({ runs }, null, 2) + '\n');
    return;
  }

  header('har env runs');
  if (runs.length === 0) {
    info('No runs found');
    return;
  }

  for (const run of runs) {
    const agent = run.agentId !== undefined ? ` agent-${run.agentId}` : '';
    info(`${run.startedAt}  ${run.stageId}${agent}  ${run.status}  (${run.trigger})`);
  }
}

export async function handleRunsGet(argv: {
  repo: string;
  runId: string;
  json?: boolean;
}): Promise<void> {
  const run = getRun(path.resolve(argv.repo), argv.runId);
  if (!run) {
    error(`Run not found: ${argv.runId}`);
    process.exit(1);
  }

  if (argv.json !== false) {
    process.stdout.write(JSON.stringify(run, null, 2) + '\n');
    return;
  }

  info(JSON.stringify(run, null, 2));
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

function printDrift(drift: HarnessDriftResult): void {
  if (drift.generatorVersion.outdated) {
    warn(
      `  Harness generator ${drift.generatorVersion.installed} → bundled ${drift.generatorVersion.bundled}`,
    );
  }
  if (drift.checksumMismatch.length > 0) {
    warn(`  Drift (template changed): ${drift.checksumMismatch.join(', ')}`);
  }
  if (drift.missing.length > 0) {
    warn(`  Missing from .har/: ${drift.missing.join(', ')}`);
  }
  if (drift.extra.length > 0) {
    warn(`  Extra/stale files: ${drift.extra.join(', ')}`);
  }
  if (drift.missingPortVars.length > 0) {
    warn(
      `  Missing port documentation vars in harness.env: ${drift.missingPortVars.join(', ')}`,
    );
    warn('  Copy the port-allocation block from the bundled template harness.env and adapt values.');
  }
  if (
    !drift.generatorVersion.outdated &&
    drift.checksumMismatch.length === 0 &&
    drift.missing.length === 0 &&
    drift.extra.length === 0 &&
    drift.missingPortVars.length === 0
  ) {
    success('  Harness matches bundled templates');
  }
}

function printNextSteps(auto: boolean): void {
  console.error('');
  console.error('  Read:         .har/README.md');
  if (!auto) {
    console.error('  Adapt:        paste prompt above into your coding agent');
    console.error('  Prompt file:  .har/ADAPT-PROMPT.md');
  } else {
    console.error('  Agent guide:  AGENT.md (repo root, if applied)');
  }
  console.error('  Setup infra:  ./.har/setup-infra.sh   # when Docker infra is enabled');
  console.error('  Launch:       har env launch 1        # preferred; or ./.har/launch.sh 1');
  console.error('  Verify:       har env verify 1         # preferred; or ./.har/verify.sh 1');
  console.error('  Maintain:     har env maintain');
  console.error('  MCP server:   har mcp');
  console.error('');
}
