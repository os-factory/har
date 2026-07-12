import * as path from 'path';
import type { Argv } from 'yargs';
import { initHarness, maintainHarness, addStageTemplate } from '../../core/harness';
import {
  STAGE_TEMPLATE_IDS,
  StageTemplateId,
  listStageTemplateIds,
} from '../../harness/stage-templates';
import { addCustomStage } from '../../harness/custom-stage';
import type { HarnessStageKind } from '../../harness/schema';
import { HarnessDriftResult } from '../../harness/drift';
import type { MaintainBundleReport } from '../../harness/maintain-bundle';
import {
  buildInitAdaptationPrompt,
  buildMaintainAdaptationPrompt,
  printAdaptationPrompt,
  writeAdaptationPrompt,
} from '../../harness/adaptation-prompt';
import { promptApplyAgentMdProposal, readAgentMdProposal, clearAgentMdProposal } from '../../harness/agent-md';
import { handleCursorRule } from '../../harness/cursor-rule';
import { handleAgentSkills } from '../../harness/agent-skills';
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
            })
            .option('agents', {
              type: 'string',
              describe: 'Scaffold agent skills for these targets (comma-separated: claude,cursor,codex); auto-detected when omitted',
            })
            .option('no-agents', {
              type: 'boolean',
              default: false,
              describe: 'Skip agent skills scaffolding',
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
            })
            .option('agents', {
              type: 'string',
              describe: 'Scaffold agent skills for these targets (comma-separated: claude,cursor,codex); auto-detected when omitted',
            })
            .option('no-agents', {
              type: 'boolean',
              default: false,
              describe: 'Skip agent skills scaffolding',
            }),
        handleMaintain,
      )
      .command(
        'add-stage [template]',
        `Add a stage template (${STAGE_TEMPLATE_IDS.join(', ')}) or a custom stage (--custom)`,
        (y: Argv) =>
          y
            .positional('template', {
              type: 'string',
              describe: `Stage template id (${STAGE_TEMPLATE_IDS.join(', ')}), or the new stage id with --custom`,
            })
            .option('list', {
              type: 'boolean',
              default: false,
              describe: 'List available stage templates and exit',
            })
            .option('custom', {
              type: 'boolean',
              default: false,
              describe: 'Register a custom stage instead of a shipped template',
            })
            .option('kind', {
              type: 'string',
              describe: 'Custom stage kind (setup, launch, verify, test, inspect, reset, teardown, custom)',
            })
            .option('command', {
              type: 'string',
              describe: 'Custom stage shell command ({agentId} is substituted), e.g. "npm test"',
            })
            .option('script', {
              type: 'boolean',
              default: false,
              describe: 'Scaffold .har/stages/<id>.sh from the contract skeleton (see .har/STAGES.md)',
            })
            .option('description', {
              type: 'string',
              describe: 'Custom stage description shown in the registry and Mission Control',
            })
            .option('verification', {
              type: 'boolean',
              default: false,
              describe: 'Include the custom stage in verify --full (stages.json verificationStages)',
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
              describe: 'Do not copy optional CI workflow files (e.g. .github/workflows/playwright.yml)',
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
            })
            .option('resume', {
              type: 'boolean',
              default: false,
              describe: 'Resume a failed or partial launch without creating a new worktree',
            }),
        handleLaunch,
      )
      .command(
        'recover <id>',
        'Resume a failed or partial launch (alias for launch --resume)',
        (y: Argv) =>
          y
            .positional('id', { type: 'number', describe: 'Agent slot id (see .har/stages.json agentSlots)' })
            .option('repo', { type: 'string', default: '.' }),
        handleRecover,
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
      .demandCommand(1, 'Please specify a subcommand: init, maintain, add-stage, launch, recover, verify, complete, teardown, status, runs'),
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
  agents?: string;
  noAgents: boolean;
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
    await handleAgentSkills({
      repoPath,
      agents: argv.agents,
      enabled: argv.noAgents ? false : undefined,
      autoYes: argv.yes,
      force: argv.force,
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
  agents?: string;
  noAgents: boolean;
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

    if (result.bundle) {
      printMaintainBundleSummary(result.bundle.report);
    }

    if (argv.finalize) {
      if (!result.validation.pass) {
        warn('Harness has validation errors — fix them before finalizing.');
        process.exit(1);
      }
      info('Manifest updated — generator version and file checksums recorded.');
    } else if (argv.auto) {
      if (!result.validation.pass) {
        warn('Harness has validation errors after maintenance.');
        process.exit(1);
      }
      await handleAgentMdProposal(repoPath, argv.yes);
    } else {
      if (!result.validation.pass) {
        warn('Harness has validation errors — fix them before running --finalize.');
      }
      emitManualAdaptationPrompt(repoPath, 'maintain', 'default', result.bundle?.report);
      info('After your coding agent finishes adapting, record it with: har env maintain --finalize');
    }

    divider();
    if (argv.finalize) {
      success('Harness finalized!');
    } else if (result.bundle) {
      success('Maintenance bundle ready!');
    } else {
      success('Harness updated!');
    }
    await handleCursorRule({
      repoPath,
      cursorRule: resolveCursorRuleFlag(argv.cursorRule, argv.noCursorRule),
      autoYes: argv.yes,
      mode: 'maintain',
    });
    await handleAgentSkills({
      repoPath,
      agents: argv.agents,
      enabled: argv.noAgents ? false : undefined,
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
  bundleReport?: MaintainBundleReport,
): void {
  const prompt =
    mode === 'init'
      ? buildInitAdaptationPrompt(repoPath, profile)
      : buildMaintainAdaptationPrompt(repoPath, bundleReport);

  writeAdaptationPrompt(repoPath, prompt);

  process.stderr.write('\n');
  if (mode === 'init') {
    info('Harness scaffolded. Adapt it with your coding agent:');
  } else {
    info('Review harness drift with your coding agent:');
  }
  info('  Paste the prompt below (also saved to .har/ADAPT-PROMPT.md)');
  if (mode === 'init') {
    info('  TODO validation warnings are expected until adaptation is complete.');
  } else if (bundleReport) {
    info('  Reference templates are in .har/maintain/templates/');
  }
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
  list: boolean;
  custom: boolean;
  kind?: string;
  command?: string;
  script: boolean;
  description?: string;
  verification: boolean;
  repo: string;
  force: boolean;
  skipCi: boolean;
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);
  const available = listStageTemplateIds();

  if (argv.list) {
    for (const id of available) {
      console.log(id);
    }
    return;
  }

  if (argv.custom) {
    if (!argv.template) {
      error(
        'Missing stage id. Usage: har env add-stage <id> --custom (--command "npm test" | --script) [--kind test] [--verification]',
      );
      process.exit(1);
    }

    header('har env add-stage --custom');
    info(`Repository: ${repoPath}`);
    info(`Stage: ${argv.template}`);

    try {
      const result = addCustomStage(repoPath, {
        id: argv.template,
        kind: argv.kind as HarnessStageKind | undefined,
        command: argv.command,
        script: argv.script,
        description: argv.description,
        verification: argv.verification,
        force: argv.force,
      });

      divider();
      success(`Custom stage registered: ${result.stageId} (kind: ${result.kind}, ${result.mode})`);
      for (const file of result.filesWritten) {
        info(`  + ${file}`);
      }
      console.error('');
      console.error('  Next steps:');
      for (const step of result.nextSteps) {
        console.error(`    ${step}`);
      }
      console.error('');
      console.error('  Docs: .har/STAGES.md');
      console.error('');
    } catch (err: unknown) {
      error((err as Error).message);
      process.exit(1);
    }
    return;
  }

  if (!argv.template || !available.includes(argv.template as StageTemplateId)) {
    error(
      `Unknown stage template: ${argv.template ?? '(missing)'}. Available: ${available.join(', ')}. For a project-specific stage, use: har env add-stage <id> --custom`,
    );
    process.exit(1);
  }

  header('har env add-stage');
  info(`Repository: ${repoPath}`);
  info(`Template: ${argv.template}`);

  try {
    const result = addStageTemplate(repoPath, argv.template as StageTemplateId, {
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
    console.error(`  Docs: ${result.docsPath}`);
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
  resume: boolean;
}): Promise<void> {
  const repo = path.resolve(argv.repo);
  const agentId = validateAgentId(argv.id, repo);

  let confirmReplace = argv.replace;
  let force = argv.force;

  if (!argv.resume) {
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
  }

  const result = await launchEnvironment({
    repoPath: repo,
    agentId,
    worktree: argv.worktree,
    claude: argv.claude,
    confirmReplace,
    force,
    resume: argv.resume,
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

export async function handleRecover(argv: { id?: number; repo: string }): Promise<void> {
  return handleLaunch({
    id: argv.id,
    repo: argv.repo,
    worktree: true,
    claude: false,
    replace: false,
    force: false,
    resume: true,
  });
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
    warn('  See maintain/templates/harness.env in the maintenance bundle.');
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

function printMaintainBundleSummary(report: MaintainBundleReport): void {
  const missing = report.actions.filter((a) => a.kind === 'missing').length;
  const drifted = report.actions.filter((a) => a.kind === 'drift').length;
  const stale = report.stale.length;
  info(`Maintenance bundle: .har/maintain/`);
  info(`  ${missing} missing, ${drifted} drifted, ${stale} stale`);
  if (!report.validation.pass) {
    warn(`  Validation: ${report.validation.errors.length} error(s) — blocks --finalize`);
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
