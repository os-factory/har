import * as path from 'path';
import type { Argv } from 'yargs';
import { finishCommand } from '../finish-command';
import { initHarness, maintainHarness, addPlugin } from '../../core/harness';
import type { MaintainMigrationInfo } from '../../core/harness';
import {
  listPluginIds,
} from '../../harness/plugins';
import { HarnessDriftResult } from '../../harness/drift';
import type { MaintainBundleReport } from '../../harness/maintain-bundle';
import {
  buildInitAdaptationPrompt,
  buildMaintainAdaptationPrompt,
  offerAdaptationPromptClipboard,
  printAdaptationPrompt,
  writeAdaptationPrompt,
} from '../../harness/adaptation-prompt';
import { handleCursorRule } from '../../harness/cursor-rule';
import { handleAgentSkills } from '../../harness/agent-skills';
import {
  handleInstructionFiles,
} from '../../harness/instruction-files';
import {
  completeEnvironment,
  getEnvironmentLogs,
  getEnvironmentStatus,
  launchEnvironment,
  listArtifacts,
  preflightEnvironment,
  runStage,
  runVerification,
  teardownEnvironment,
} from '../../core/run-service';
import { listRuns, getRun } from '../../core/runs';
import { runAgentOp } from '../../runtime';
import { addWorkUnitLinks, parseWorkLinkSpec } from '../../core/work-units';
import { resolveHarnessRoot } from '../../harness/manifest';
import { adoptHarness, ejectHarness } from '../../harness/eject';
import { formatDoctorReport, runDoctor, summarizeDoctorReport } from '../../harness/doctor';
import {
  confirmCleanupSelection,
  discoverCleanupCandidates,
  executeCleanupCandidates,
  formatCleanupPlan,
  parseCleanupKeepPins,
  selectAutoApprovedCandidates,
} from '../../core/cleanup-service';
import { handleCommitGateOnboarding } from '../../core/commit-gate-onboarding';
import { warnIfDockerUnavailable } from '../../core/docker-status';
import { readOnboardingPreferences } from '../../core/onboarding-preferences';
import { EnvironmentStatusSchema, SlotReadinessSchema } from '../../harness/schema';
import { validateAgentId } from '../../utils/validation';
import { slimVerificationResult } from '../../core/results';
import { info, success, error, header, divider, warn } from '../../utils/logging';
import {
  HAR_ENV_EPILOG,
  LAUNCH_COMMAND_DESCRIBE,
  LAUNCH_EPILOG,
  LAUNCH_RESUME_DESCRIBE,
} from '../help-text';

// Operation × surface matrix (CLI ↔ MCP) is documented in AGENTS.md — keep it
// current when adding or removing a subcommand here or a tool in mcp/server.ts.
const workLinkOptions = (y: Argv) =>
  y
    .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
    .option('work-id', {
      type: 'string',
      demandOption: true,
      describe: 'Repo-scoped work unit id (same as --work-id at launch)',
    })
    .option('link', {
      type: 'string',
      describe: 'Link as source|url or source|url|label',
    })
    .option('source', { type: 'string', describe: 'Tracker provider (e.g. github, jira)' })
    .option('url', { type: 'string', describe: 'Canonical URL for the link' })
    .option('label', { type: 'string', describe: 'Optional display label' });

export const envCommand = {
  command: 'env <subcommand>',
  describe: 'Manage agent environments (launch → verify → complete)',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'init',
        'Copy harness boilerplate into .har/',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('verbose', { alias: 'v', type: 'boolean', default: false })
            .option('force', { type: 'boolean', default: false, describe: 'Overwrite existing .har/' })
            .option('smoke', { type: 'boolean', default: false, describe: 'Run setup-infra.sh after adaptation' })
            .option('profile', {
              type: 'string',
              choices: ['default', 'cli', 'ios'] as const,
              default: 'default' as const,
              describe: 'Boilerplate profile: default (web app), cli (library/CLI, no PM2), ios (iOS mobile app)',
            })
            .option('yes', {
              type: 'boolean',
              default: false,
              describe: 'Accept recommended onboarding actions without prompting',
            })
            .option('cursor-rule', {
              type: 'boolean',
              // No default: unset → prompt/auto-detect; --cursor-rule → true; --no-cursor-rule → false
              // (do not declare a separate --no-cursor-rule option — yargs negation owns that.)
              describe:
                'Create .cursor/rules/har-workflow.mdc without prompting (use --no-cursor-rule to skip)',
            })
            .option('agents', {
              type: 'string',
              // --no-agents is yargs negation of this string option (sets agents=false). Do not
              // declare a separate --no-agents boolean — it collides and crashes parseAgentTargets.
              describe:
                'Scaffold agent skills for these targets (comma-separated: claude,cursor,codex); auto-detected when omitted; --no-agents to skip',
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
        handleInit,
      )
      .command(
        'maintain',
        'Validate .har/ and print a maintenance prompt',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', default: '.' })
            .option('verbose', { alias: 'v', type: 'boolean', default: false })
            .option('yes', {
              type: 'boolean',
              default: false,
              describe: 'Accept recommended maintenance actions without prompting',
            })
            .option('finalize', {
              type: 'boolean',
              default: false,
              describe: 'Record the completed manual adaptation in .har/manifest.json (updates file checksums)',
            })
            .option('migrate', {
              type: 'boolean',
              default: false,
              describe:
                'Apply the pending mechanical migration steps (pre-1.0 → 1.0; backups in .har/migrate/backup/)',
            })
            .option('summary', {
              type: 'string',
              describe: 'Adaptation summary to store in the manifest (--finalize only)',
            })
            .option('cursor-rule', {
              type: 'boolean',
              // No default: unset → prompt/auto-detect; --cursor-rule → true; --no-cursor-rule → false
              describe:
                'Create .cursor/rules/har-workflow.mdc without prompting (use --no-cursor-rule to skip)',
            })
            .option('agents', {
              type: 'string',
              describe:
                'Scaffold agent skills for these targets (comma-separated: claude,cursor,codex); auto-detected when omitted; --no-agents to skip',
            })
            .option('commit-gate', {
              choices: ['prompt', 'always', 'never'] as const,
              describe: 'Install or refresh commit hooks (defaults to user preferences)',
            })
            .option('gate-mode', {
              choices: ['block', 'warn'] as const,
              describe: 'Policy for commits without a passing full verification',
            })
            .option('gate-scope', {
              choices: ['worktrees', 'all'] as const,
              describe: 'Apply the commit policy to HAR worktrees or every checkout',
            }),
        handleMaintain,
      )
      .command(
        'add-plugin [plugin]',
        'Install a verification plugin (bundled id, path, npm package, or git URL) that registers stages',
        (y: Argv) =>
          y
            .positional('plugin', {
              type: 'string',
              describe:
                'Bundled plugin id, local path (./plugin), npm package (@org/pkg), or git URL (github:org/repo)',
            })
            .option('list', {
              type: 'boolean',
              default: false,
              describe: 'List bundled plugins and exit',
            })
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('force', {
              type: 'boolean',
              default: false,
              describe: 'Overwrite existing plugin files and stage entry',
            })
            .option('skip-ci', {
              type: 'boolean',
              default: true,
              describe:
                'Do not copy optional CI workflow files (default; pass --with-ci to include them)',
            })
            .option('with-ci', {
              type: 'boolean',
              default: false,
              describe: 'Copy optional CI workflow files (e.g. .github/workflows/playwright.yml)',
            }),
        handleAddPlugin,
      )
      .command(
        'add-stage [template]',
        `Install a plugin (deprecated alias for add-plugin); --custom was removed in 1.0 (use har plugin create)`,
        (y: Argv) =>
          y
            .positional('template', {
              type: 'string',
              describe: 'Plugin id / path / npm / git spec (deprecated alias for add-plugin)',
            })
            .option('list', {
              type: 'boolean',
              default: false,
              describe: 'List available plugins and exit (prefer: har env add-plugin --list)',
            })
            .option('custom', {
              type: 'boolean',
              default: false,
              hidden: true,
              describe: 'Removed in 1.0 — use: har plugin create <id>',
            })
            .option('kind', { type: 'string', hidden: true })
            .option('command', { type: 'string', hidden: true })
            .option('script', { type: 'boolean', default: false, hidden: true })
            .option('description', { type: 'string', hidden: true })
            .option('verification', { type: 'boolean', default: false, hidden: true })
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('force', {
              type: 'boolean',
              default: false,
              describe: 'Overwrite existing plugin files and stage entry',
            })
            .option('skip-ci', {
              type: 'boolean',
              default: true,
              describe:
                'Do not copy optional CI workflow files (default; pass --with-ci to include them)',
            })
            .option('with-ci', {
              type: 'boolean',
              default: false,
              describe: 'Copy optional CI workflow files (e.g. .github/workflows/playwright.yml)',
            }),
        handleAddStage,
      )
      .command(
        'launch <id>',
        LAUNCH_COMMAND_DESCRIBE,
        (y: Argv) =>
          y
            .positional('id', { type: 'number', describe: 'Agent slot id (see .har/stages.json agentSlots)' })
            .option('repo', {
              type: 'string',
              default: '.',
              describe: 'Main checkout whose HEAD becomes the new session base',
            })
            .option('worktree', {
              type: 'boolean',
              default: true,
              describe: 'Use an isolated git worktree (default)',
            })
            .option('claude', { type: 'boolean', default: false })
            .option('resume', {
              type: 'boolean',
              default: false,
              describe: LAUNCH_RESUME_DESCRIBE,
            })
            .option('work-id', {
              type: 'string',
              describe:
                'Short repo-scoped work id (e.g. widget-123). Bind when the task names a tracker issue or ticket',
            })
            .option('work-source', {
              type: 'string',
              describe: 'Tracker provider when binding work (for example github or linear)',
            })
            .option('work-url', {
              type: 'string',
              describe: 'Canonical URL for the work item (for example a GitHub issue URL)',
            })
            .option('work-title', {
              type: 'string',
              describe: 'Human-readable work title when known',
            })
            .option('parent-work-id', {
              type: 'string',
              describe: 'Optional parent work unit identifier',
            })
            .option('work-link', {
              type: 'array',
              string: true,
              describe:
                'Additional tracker link: source|url or source|url|label (repeatable)',
            })
            .epilog(LAUNCH_EPILOG),
        handleLaunch,
      )
      .command(
        'work-link',
        'Append a related external link to an existing work unit',
        workLinkOptions,
        handleWorkLink,
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
        'Check whether a slot can launch now (ports, PM2, Docker, occupied slot, untracked worktree paths)',
        (y: Argv) =>
          y
            .positional('id', { type: 'number', describe: 'Agent slot id (see .har/stages.json agentSlots)' })
            .option('repo', { type: 'string', default: '.' })
            .option('json', { type: 'boolean', default: false, describe: 'Structured JSON output' }),
        handlePreflight,
      )
      .command(
        'verify <id>',
        'Run verification suite for an agent',
        (y: Argv) =>
          y
            .positional('id', { type: 'number', describe: 'Agent slot id (see .har/stages.json agentSlots)' })
            .option('repo', { type: 'string', default: '.' })
            .option('full', { type: 'boolean', default: false })
            .option('json', {
              type: 'boolean',
              default: false,
              describe: 'Structured JSON (passing steps omit output; default is progress only)',
            }),
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
        'setup-infra',
        'Set up shared infrastructure for all agent slots (Docker services, template DB, or the iOS toolchain)',
        (y: Argv) => y.option('repo', { type: 'string', default: '.', describe: 'Path to the repository' }),
        handleSetupInfra,
      )
      .command(
        'agent <id> <command> [args..]',
        'Per-slot operations against a running environment (status, logs, restart, psql, health, url, reset-db, slow-queries, exec, attach)',
        (y: Argv) =>
          y
            .positional('id', { type: 'number', describe: 'Agent slot id (see .har/stages.json agentSlots)' })
            .positional('command', { type: 'string', describe: 'Operation to run' })
            .positional('args', { type: 'string', array: true, describe: 'Operation arguments' })
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' }),
        handleAgent,
      )
      .command(
        'doctor',
        'Validate the harness contract: harness.env schema, stages.json, stage scripts, verification ids, port lanes, slot registry',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', default: '.' })
            .option('json', { type: 'boolean', default: false, describe: 'Structured JSON output (exit 0 pass, 1 errors)' }),
        handleDoctor,
      )
      .command(
        'eject',
        'Vendor the HAR runtime into .har/ and own the scripts yourself (reversible: har env adopt)',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
            .option('yes', {
              alias: 'y',
              type: 'boolean',
              default: false,
              describe: 'Skip the confirmation prompt',
            }),
        handleEject,
      )
      .command(
        'adopt',
        'Return an ejected harness to managed shims (removes .har/runtime/, keeps your config)',
        (y: Argv) => y.option('repo', { type: 'string', default: '.', describe: 'Path to the repository' }),
        handleAdopt,
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
        'logs <id> [service]',
        'Show recent logs for an agent slot (optionally one service)',
        (y: Argv) =>
          y
            .positional('id', { type: 'number', describe: 'Agent slot id (see .har/stages.json agentSlots)' })
            .positional('service', { type: 'string', describe: 'Limit logs to one service' })
            .option('repo', { type: 'string', default: '.' }),
        handleLogs,
      )
      .command(
        'run-stage <id> <stage> [args..]',
        'Run one registered harness stage by id for an agent slot',
        (y: Argv) =>
          y
            .positional('id', { type: 'number', describe: 'Agent slot id (see .har/stages.json agentSlots)' })
            .positional('stage', { type: 'string', describe: 'Stage id from .har/stages.json' })
            .positional('args', { type: 'string', array: true, describe: 'Extra arguments passed to the stage' })
            .option('repo', { type: 'string', default: '.' })
            .option('json', { type: 'boolean', default: false, describe: 'Structured JSON output' }),
        handleRunStage,
      )
      .command(
        'artifacts',
        'List result JSON, screenshots, traces, and reports under .har/artifacts/',
        (y: Argv) =>
          y
            .option('repo', { type: 'string', default: '.' })
            .option('stage', { type: 'string', describe: 'Filter by stage id' })
            .option('json', { type: 'boolean', default: false, describe: 'Structured JSON output' }),
        handleArtifacts,
      )
      .command(
        'cleanup',
        'Discover stale session worktrees across registered repos and tear them down',
        (y: Argv) =>
          y
            .option('repo', {
              type: 'string',
              describe: 'Limit cleanup scan to one repository path',
            })
            .option('dry-run', {
              type: 'boolean',
              default: false,
              describe: 'Show the cleanup plan without executing',
            })
            .option('yes', {
              alias: 'y',
              type: 'boolean',
              default: false,
              describe: 'Approve teardown/remove for recommended rows without prompting',
            })
            .option('keep', {
              type: 'string',
              describe:
                'Pin sessions to keep (comma-separated repoPath:agentId or worktree paths)',
            })
            .option('stale', {
              type: 'number',
              default: 7,
              describe: 'Age in days before a clean idle session is recommended for teardown',
            })
            .option('orphans', {
              type: 'boolean',
              default: true,
              describe: 'Include orphan worktree directories under ~/worktrees',
            })
            .option('include-review', {
              type: 'boolean',
              default: false,
              describe: 'With --yes, also teardown/remove rows marked review (dirty or recent active)',
            })
            .option('json', { type: 'boolean', default: false, describe: 'Structured JSON output' }),
        handleCleanup,
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
      .demandCommand(
        1,
        'Please specify a subcommand: init, maintain, add-plugin, add-stage, launch, recover, verify, complete, teardown, doctor, eject, adopt, status, logs, run-stage, artifacts, cleanup, runs',
      )
      .epilog(HAR_ENV_EPILOG),
  handler: () => {},
};

export async function handleInit(argv: {
  repo: string;
  verbose: boolean;
  force: boolean;
  smoke: boolean;
  yes: boolean;
  profile: 'default' | 'cli' | 'ios';
  /** Tri-state from yargs: unset | --cursor-rule | --no-cursor-rule */
  cursorRule?: boolean;
  /** String from --agents=…, or `false` when --no-agents (yargs negation). */
  agents?: string | false;
  commitGate?: 'prompt' | 'always' | 'never';
  gateMode?: 'block' | 'warn';
  gateScope?: 'worktrees' | 'all';
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);
  const onboarding = resolveOnboardingOptions(argv);

  header('har env init');
  info(`Repository: ${repoPath}`);
  // Docker is required (Mission Control container + harness infra) — warn early.
  warnIfDockerUnavailable();

  try {
    const result = await initHarness({
      repoPath,
      force: argv.force,
      verbose: argv.verbose,
      smoke: argv.smoke,
      profile: argv.profile,
    });

    divider();
    info('Validating harness...');
    printValidation(result.validation);

    if (result.smoke) {
      printValidation(result.smoke);
      if (!result.smoke.pass) return finishCommand(1);
    }

    if (!result.validation.pass) {
      warn('Harness has validation errors — review .har/ and fix manually.');
      return finishCommand(1);
    }

    await emitManualAdaptationPrompt(repoPath, 'init', argv.profile, undefined, argv.yes);

    divider();
    success('Harness initialized!');
    await handleCommitGateOnboarding({
      repoPath,
      ...onboarding.commitGate,
      autoYes: argv.yes,
    });
    await applyAgentIntegrations({
      repoPath,
      mode: 'init',
      autoYes: argv.yes,
      force: argv.force,
      cursorRule: onboarding.cursorRule,
      ...onboarding.agentSkills,
    });
    printNextSteps();
  } catch (err: unknown) {
    error((err as Error).message);
    return finishCommand(1);
  }
}

export async function handleMaintain(argv: {
  repo: string;
  verbose: boolean;
  yes: boolean;
  finalize: boolean;
  migrate?: boolean;
  summary?: string;
  /** Tri-state from yargs: unset | --cursor-rule | --no-cursor-rule */
  cursorRule?: boolean;
  /** String from --agents=…, or `false` when --no-agents (yargs negation). */
  agents?: string | false;
  commitGate?: 'prompt' | 'always' | 'never';
  gateMode?: 'block' | 'warn';
  gateScope?: 'worktrees' | 'all';
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);
  const onboarding = resolveOnboardingOptions(argv);

  header('har env maintain');
  info(`Repository: ${repoPath}`);

  try {
    const result = await maintainHarness({
      repoPath,
      verbose: argv.verbose,
      finalize: argv.finalize,
      migrate: argv.migrate,
      summary: argv.summary,
    });

    if (result.migration) {
      printMigrationSummary(result.migration);
    } else if (argv.migrate) {
      info('No pending migration — the harness is already on the 1.0 shape.');
    }

    divider();
    info('Validating harness...');
    printValidation(result.validation);
    printDrift(result.drift);

    // Doctor runs automatically on every maintain (#232).
    if (result.doctor.ok) {
      const summary = summarizeDoctorReport(result.doctor);
      info(summary ? `Doctor: PASS (${summary})` : 'Doctor: PASS');
    } else {
      warn('Doctor: FAIL — harness contract is broken:');
      for (const line of formatDoctorReport(result.doctor).split('\n')) {
        info(line);
      }
    }

    if (result.bundle) {
      printMaintainBundleSummary(result.bundle.report);
    }

    if (argv.finalize) {
      if (!result.validation.pass) {
        warn('Harness has validation errors — fix them before finalizing.');
        return finishCommand(1);
      }
      info('Manifest updated — file checksums recorded.');
    } else {
      if (!result.validation.pass) {
        warn('Harness has validation errors — fix them before running --finalize.');
      }
      if (result.migration) {
        info('Migration prompt for your coding agent (also saved to .har/MIGRATE-PROMPT.md):');
        printAdaptationPrompt(result.migration.prompt);
        await offerAdaptationPromptClipboard(result.migration.prompt, { autoYes: argv.yes });
        info(
          'After your coding agent finishes the migration, record it with: har env maintain --finalize',
        );
      } else {
        await emitManualAdaptationPrompt(
          repoPath,
          'maintain',
          'default',
          result.bundle?.report,
          argv.yes,
        );
        info('After your coding agent finishes adapting, record it with: har env maintain --finalize');
      }
    }

    divider();
    if (argv.finalize) {
      success('Harness finalized!');
    } else if (result.bundle) {
      success('Maintenance bundle ready!');
    } else {
      success('Harness updated!');
    }
    await handleCommitGateOnboarding({
      repoPath,
      ...onboarding.commitGate,
      autoYes: argv.yes,
    });
    await applyAgentIntegrations({
      repoPath,
      mode: 'maintain',
      autoYes: argv.yes,
      cursorRule: onboarding.cursorRule,
      writeAgentsMd: !argv.finalize,
      finalize: argv.finalize,
      ...onboarding.agentSkills,
    });
  } catch (err: unknown) {
    error((err as Error).message);
    return finishCommand(1);
  }
}

/**
 * Map yargs `--cursor-rule` / `--no-cursor-rule` onto the tri-state handleCursorRule expects.
 * Do not declare a separate `--no-cursor-rule` option — yargs negation sets this to false.
 */
export function resolveCursorRuleFlag(cursorRule: boolean | undefined): boolean | undefined {
  return cursorRule;
}

/**
 * Map yargs `--agents` / `--no-agents` onto handleAgentSkills options.
 * `--no-agents` is yargs negation of the string `--agents` option and yields `false`.
 */
export function resolveAgentsScaffoldOptions(agents: string | false | undefined): {
  agents?: string;
  enabled?: boolean;
} {
  if (agents === false) return { enabled: false };
  if (typeof agents === 'string') return { agents };
  return {};
}

export function resolveOnboardingOptions(argv: {
  cursorRule?: boolean;
  agents?: string | false;
  commitGate?: 'prompt' | 'always' | 'never';
  gateMode?: 'block' | 'warn';
  gateScope?: 'worktrees' | 'all';
}): {
  cursorRule?: boolean;
  agentSkills: { agents?: string; enabled?: boolean };
  commitGate: {
    install: 'prompt' | 'always' | 'never';
    mode: 'block' | 'warn';
    scope: 'worktrees' | 'all';
  };
} {
  const preferences = readOnboardingPreferences();
  const preferredCursorRule =
    preferences.cursorRule === 'auto' ? undefined : preferences.cursorRule === 'on';
  const preferredAgentSkills =
    preferences.agentSkills === 'auto'
      ? {}
      : preferences.agentSkills.length === 0
        ? { enabled: false }
        : { agents: preferences.agentSkills.join(',') };

  return {
    cursorRule: argv.cursorRule ?? preferredCursorRule,
    agentSkills:
      argv.agents === undefined ? preferredAgentSkills : resolveAgentsScaffoldOptions(argv.agents),
    commitGate: {
      install: argv.commitGate ?? preferences.commitGate.install,
      mode: argv.gateMode ?? preferences.commitGate.mode,
      scope: argv.gateScope ?? preferences.commitGate.scope,
    },
  };
}

async function emitManualAdaptationPrompt(
  repoPath: string,
  mode: 'init' | 'maintain',
  profile: 'default' | 'cli' | 'ios' = 'default',
  bundleReport?: MaintainBundleReport,
  autoYes = false,
): Promise<void> {
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
  await offerAdaptationPromptClipboard(prompt, { autoYes });
}


/**
 * Detect instruction files, write AGENTS.md, migrate legacy instruction files, then install
 * Cursor rule + skills for confirmed targets (no double prompts).
 */
export async function applyAgentIntegrations(options: {
  repoPath: string;
  mode: 'init' | 'maintain';
  autoYes?: boolean;
  force?: boolean;
  cursorRule?: boolean;
  agents?: string;
  enabled?: boolean;
  /** Skip AGENTS.md writes (e.g. already handled during maintain --finalize). */
  writeAgentsMd?: boolean;
  finalize?: boolean;
}): Promise<void> {
  const instruction = await handleInstructionFiles({
    repoPath: options.repoPath,
    agents: options.agents,
    enabled: options.enabled,
    cursorRule: options.cursorRule,
    autoYes: options.autoYes,
    mode: options.mode,
    writeAgentsMd: options.writeAgentsMd,
    finalize: options.finalize,
  });

  const cursorRuleFlag =
    options.cursorRule === false
      ? false
      : options.cursorRule === true || instruction.plan.cursorRule
        ? true
        : false;

  await handleCursorRule({
    repoPath: options.repoPath,
    cursorRule: cursorRuleFlag,
    autoYes: options.autoYes,
    mode: options.mode,
  });

  if (instruction.plan.skills.length > 0) {
    await handleAgentSkills({
      repoPath: options.repoPath,
      agents: instruction.plan.skills.join(','),
      autoYes: options.autoYes,
      force: options.force,
      mode: options.mode,
    });
  } else if (options.enabled === false) {
    // explicit --no-agents: nothing to scaffold
  }
}

export async function handleAddPlugin(argv: {
  plugin?: string;
  list: boolean;
  repo: string;
  force: boolean;
  skipCi: boolean;
  withCi?: boolean;
}): Promise<void> {
  const repoPath = path.resolve(argv.repo);
  const available = listPluginIds();

  if (argv.list) {
    for (const id of available) {
      console.log(id);
    }
    return;
  }

  if (!argv.plugin) {
    error(
      `Missing plugin. Bundled: ${available.join(', ') || '(none)'}. ` +
        `Or pass a path, npm package, or git URL. For a project-owned plugin, scaffold one with: har plugin create <id>`,
    );
    return finishCommand(1);
  }

  header('har env add-plugin');
  info(`Repository: ${repoPath}`);
  info(`Plugin: ${argv.plugin}`);

  try {
    const result = addPlugin(repoPath, argv.plugin, {
      force: argv.force,
      // --with-ci wins over the skip-ci default: CI workflows are opt-in.
      skipCi: argv.withCi ? false : argv.skipCi,
      spec: argv.plugin,
    });

    divider();
    const stageLabel =
      result.stageIds.length > 1
        ? `stages: ${result.stageIds.join(', ')}`
        : `stage: ${result.stageId}`;
    success(`Plugin applied — registered ${stageLabel} (source: ${result.source})`);
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
    return finishCommand(1);
  }
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
  withCi?: boolean;
}): Promise<void> {
  const available = listPluginIds();

  if (argv.list) {
    warn('har env add-stage --list is deprecated; prefer: har env add-plugin --list');
    for (const id of available) {
      console.log(id);
    }
    return;
  }

  if (argv.custom) {
    const id = argv.template ?? '<id>';
    error(
      `har env add-stage --custom was removed in 1.0. Custom stages are local plugins now — run: har plugin create ${id}` +
        (argv.command
          ? `. For a one-liner like "${argv.command}", register a command stage directly in .har/stages.json instead (see .har/STAGES.md).`
          : '. For a simple one-liner, register a command stage directly in .har/stages.json (see .har/STAGES.md).'),
    );
    return finishCommand(1);
  }

  if (!argv.template) {
    error(
      `Unknown plugin: (missing). Available: ${available.join(', ')}. Prefer: har env add-plugin <id>. For a project-owned plugin, scaffold one with: har plugin create <id>`,
    );
    return finishCommand(1);
  }

  warn(
    `har env add-stage ${argv.template} is deprecated; use: har env add-plugin ${argv.template}`,
  );
  await handleAddPlugin({
    plugin: argv.template,
    list: false,
    repo: argv.repo,
    force: argv.force,
    skipCi: argv.skipCi,
    withCi: argv.withCi,
  });
}

export async function handlePreflight(argv: {
  id?: number;
  repo: string;
  json?: boolean;
}): Promise<void> {
  const repo = path.resolve(argv.repo);
  const agentId = validateAgentId(argv.id, repo);
  const result = await preflightEnvironment({
    repoPath: repo,
    agentId,
  });

  if (argv.json) {
    const output = SlotReadinessSchema.parse(result.readiness);
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return finishCommand(result.code);
    return;
  }

  if (result.stdout) process.stdout.write(result.stdout);
  return finishCommand(result.code);
}

export async function handleLaunch(argv: {
  id?: number;
  repo: string;
  worktree: boolean;
  claude: boolean;
  resume: boolean;
  workId?: string;
  workSource?: string;
  workUrl?: string;
  workTitle?: string;
  parentWorkId?: string;
  workLink?: string[];
}): Promise<void> {
  const repo = path.resolve(argv.repo);
  const agentId = validateAgentId(argv.id, repo);

  // The launch guard runs exactly once, inside run-service (also on --resume);
  // this layer only renders the outcome.
  const result = await launchEnvironment({
    repoPath: repo,
    agentId,
    worktree: argv.worktree,
    claude: argv.claude,
    resume: argv.resume,
    workUnitId: argv.workId,
    source: argv.workSource,
    sourceUrl: argv.workUrl,
    title: argv.workTitle,
    parentWorkUnitId: argv.parentWorkId,
    relatedLinks: argv.workLink?.map(parseWorkLinkSpec),
    capture: false,
  });
  if (result.blocked) {
    error(result.stderr || 'Launch blocked: slot is occupied.');
    return finishCommand(result.code || 2);
  }
  for (const warning of result.warnings ?? []) {
    warn(warning);
  }
  if (result.code === 0 && result.workDir) {
    if (result.stderr) {
      for (const line of result.stderr.split('\n').filter(Boolean)) {
        if (/telemetry|mission control|otel/i.test(line)) {
          info(line);
        }
      }
    }
    divider();
    success(`Session ready — make ALL file edits under: ${result.workDir}`);
    if (result.branch) info(`Branch: ${result.branch}`);
  }
  return finishCommand(result.code);
}

export async function handleWorkLink(argv: {
  repo: string;
  workId: string;
  link?: string;
  source?: string;
  url?: string;
  label?: string;
}): Promise<void> {
  if (!argv.link && !(argv.source && argv.url)) {
    error('Provide --link or both --source and --url');
    return finishCommand(1);
  }

  const harnessRoot = resolveHarnessRoot(path.resolve(argv.repo));
  const links = argv.link
    ? [parseWorkLinkSpec(argv.link)]
    : [{ source: argv.source!, url: argv.url!, label: argv.label }];

  try {
    const record = addWorkUnitLinks(harnessRoot, argv.workId, links);
    success(`Added link to work unit ${record.workUnitId}`);
    return finishCommand(0);
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return finishCommand(1);
  }
}

export async function handleRecover(argv: { id?: number; repo: string }): Promise<void> {
  return handleLaunch({
    id: argv.id,
    repo: argv.repo,
    worktree: true,
    claude: false,
    resume: true,
    workId: undefined,
    workSource: undefined,
    workUrl: undefined,
    workTitle: undefined,
    parentWorkId: undefined,
  });
}

export async function handleVerify(argv: {
  id?: number;
  repo: string;
  full: boolean;
  json?: boolean;
}): Promise<void> {
  const repo = path.resolve(argv.repo);
  const agentId = validateAgentId(argv.id, repo);
  const result = await runVerification({
    repoPath: repo,
    agentId,
    full: argv.full,
    capture: Boolean(argv.json),
  });

  if (argv.json) {
    const payload = slimVerificationResult(result.verification) ?? {
      status: result.code === 0 ? 'pass' : 'fail',
      agent_id: agentId,
      stages: [],
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return finishCommand(result.code);
  }

  if (result.verification) {
    const failed = result.verification.stages.filter((stage) => !stage.pass).map((stage) => stage.name);
    const elapsed =
      result.verification.total_ms != null ? ` (${result.verification.total_ms}ms)` : '';
    if (failed.length > 0) {
      error(`Verification failed: ${failed.join(', ')}${elapsed}`);
    } else {
      success(`Verification ${result.verification.status}${elapsed}`);
    }
  }

  return finishCommand(result.code);
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
  return finishCommand(result.code);
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
  return finishCommand(result.code);
}

export async function handleSetupInfra(argv: { repo: string }): Promise<void> {
  const repo = path.resolve(argv.repo);
  const result = await runStage({
    repoPath: repo,
    kind: 'setup',
    capture: false,
    trigger: 'cli',
  });
  return finishCommand(result.code ?? (result.status === 'pass' ? 0 : 1));
}

export async function handleAgent(argv: {
  id?: number;
  command?: string;
  args?: string[];
  repo: string;
}): Promise<void> {
  const repo = path.resolve(argv.repo);
  const agentId = validateAgentId(argv.id, repo);
  const result = await runAgentOp({
    repoPath: repo,
    agentId,
    command: argv.command ?? 'status',
    args: argv.args,
  });
  return finishCommand(result.code);
}

export async function handleDoctor(argv: { repo: string; json?: boolean }): Promise<void> {
  const repoPath = path.resolve(argv.repo);
  const report = runDoctor(repoPath);

  if (argv.json) {
    console.log(JSON.stringify(report, null, 2));
    return finishCommand(report.ok ? 0 : 1);
  }

  header('har env doctor');
  info(`Repository: ${repoPath}`);
  divider();
  for (const line of formatDoctorReport(report).split('\n')) {
    info(line);
  }
  divider();
  if (report.ok) {
    success('Harness contract is healthy.');
  } else {
    error('Harness contract is broken — fix the errors above.');
  }
  return finishCommand(report.ok ? 0 : 1);
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

export async function handleEject(argv: { repo: string; yes: boolean }): Promise<void> {
  const repoPath = resolveHarnessRoot(path.resolve(argv.repo));

  header('har env eject');
  warn('This vendors the complete HAR runtime into .har/runtime/ and rewrites the');
  warn('.har/*.sh scripts to execute it directly — from then on YOU OWN those files:');
  warn('  • har env maintain will no longer update them (no upstream drift reports)');
  warn('  • upstream fixes and features reach you only by re-ejecting or adopting');
  warn('  • support covers issues reproducible with managed shims; changes you make');
  warn('    to the ejected runtime are yours to maintain');
  warn('Config files (harness.env, stages.json, stages/, hooks, docs) stay managed.');
  info('Reversible anytime: `har env adopt` (or `har env init --force`).');

  if (!argv.yes) {
    const ok = await confirm('Eject the runtime and own the scripts yourself? [y/N] ');
    if (!ok) {
      info('Aborted — nothing changed. Pass --yes to skip this prompt.');
      return finishCommand(1);
    }
  }

  try {
    const result = ejectHarness(repoPath);
    success(`Ejected @osfactory/har@${result.version} → .har/runtime/`);
    info(`  Rewritten as user-owned: ${result.scripts.map((s) => `.har/${s}`).join(', ')}`);
    info('  Recorded in .har/manifest.json (ejected: true) — commit .har/ to keep it.');
    info('  Return to managed shims anytime: har env adopt');
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return finishCommand(1);
  }
  return finishCommand(0);
}

export async function handleAdopt(argv: { repo: string }): Promise<void> {
  const repoPath = resolveHarnessRoot(path.resolve(argv.repo));
  try {
    const result = adoptHarness(repoPath);
    success('Returned to managed shims — .har/runtime/ removed, eject flag cleared.');
    info(`  Regenerated: ${result.scripts.map((s) => `.har/${s}`).join(', ')}`);
    info('  Config surface files (harness.env, stages.json, stages/, docs) were not touched.');
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    return finishCommand(1);
  }
  return finishCommand(0);
}

export async function handleStatus(argv: { repo: string; json?: boolean }): Promise<void> {
  const repoPath = path.resolve(argv.repo);

  // One status implementation for text, --json, and MCP: the structured
  // collector inside getEnvironmentStatus. Status is a pure read (no run records).
  const result = await getEnvironmentStatus({
    repoPath,
    capture: false,
  });

  if (argv.json) {
    const output = EnvironmentStatusSchema.parse(result.status);
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return;
  }

  if (result.stdout) process.stdout.write(result.stdout);
}

export async function handleLogs(argv: {
  id?: number;
  repo: string;
  service?: string;
}): Promise<void> {
  const repo = path.resolve(argv.repo);
  const agentId = validateAgentId(argv.id, repo);
  const result = await getEnvironmentLogs({
    repoPath: repo,
    agentId,
    service: argv.service,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return finishCommand(result.code);
}

export async function handleRunStage(argv: {
  id?: number;
  stage?: string;
  repo: string;
  args?: string[];
  json?: boolean;
}): Promise<void> {
  const repo = path.resolve(argv.repo);
  const agentId = validateAgentId(argv.id, repo);
  if (!argv.stage) {
    error('Missing stage id. Usage: har env run-stage <id> <stage> [args..]');
    return finishCommand(1);
  }

  try {
    const result = await runStage({
      repoPath: repo,
      stageId: argv.stage,
      agentId,
      args: argv.args,
      capture: Boolean(argv.json),
    });
    if (argv.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    }
    const code = result.code ?? (result.status === 'pass' ? 0 : 1);
    return finishCommand(code);
  } catch (err: unknown) {
    error(err instanceof Error ? err.message : String(err));
    return finishCommand(1);
  }
}

export async function handleArtifacts(argv: {
  repo: string;
  stage?: string;
  json?: boolean;
}): Promise<void> {
  const artifacts = listArtifacts({
    repoPath: path.resolve(argv.repo),
    stageId: argv.stage,
  });

  if (argv.json) {
    process.stdout.write(JSON.stringify({ artifacts }, null, 2) + '\n');
    return;
  }

  header('har env artifacts');
  if (artifacts.length === 0) {
    info('No artifacts found under .har/artifacts/');
    return;
  }
  for (const artifact of artifacts) {
    info(`${artifact.relativePath}  (${artifact.sizeBytes} bytes, ${artifact.modifiedAt})`);
  }
}

export async function handleCleanup(argv: {
  repo?: string;
  dryRun?: boolean;
  yes?: boolean;
  keep?: string;
  stale?: number;
  orphans?: boolean;
  includeReview?: boolean;
  json?: boolean;
}): Promise<void> {
  const keepValues = argv.keep
    ?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const keep = parseCleanupKeepPins(keepValues);
  const repoPaths = argv.repo ? [path.resolve(argv.repo)] : undefined;

  const plan = await discoverCleanupCandidates({
    cwd: process.cwd(),
    repoPaths,
    keep,
    staleDays: argv.stale,
    orphans: argv.orphans,
  });

  if (argv.json) {
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    if (argv.dryRun) return;
  } else {
    header('har env cleanup');
    process.stdout.write(`${formatCleanupPlan(plan)}\n\n`);
    if (argv.dryRun) {
      info('Dry run — no changes made.');
      return;
    }
  }

  let selected = selectAutoApprovedCandidates(plan, { includeReview: argv.includeReview });
  if (!argv.yes) {
    try {
      const interactive = await confirmCleanupSelection(plan.candidates);
      selected = interactive;
    } catch (err: unknown) {
      error(err instanceof Error ? err.message : String(err));
      return finishCommand(1);
    }
  }

  if (selected.length === 0) {
    info('Nothing selected for cleanup.');
    return;
  }

  const outcomes = await executeCleanupCandidates(selected, { dryRun: false });
  let failed = 0;
  for (const outcome of outcomes) {
    const label =
      outcome.candidate.kind === 'orphan_worktree'
        ? outcome.candidate.worktreePath
        : `${outcome.candidate.projectName} agent ${outcome.candidate.agentId}`;
    if (outcome.ok) {
      success(`Cleaned ${label}`);
    } else {
      failed++;
      error(`${label}: ${outcome.error ?? 'failed'}`);
    }
  }

  return finishCommand(failed > 0 ? 1 : 0);
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
    return finishCommand(1);
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
  if (drift.ownedByUser.length > 0) {
    info(`  User-owned (ejected, never drift-checked): ${drift.ownedByUser.join(', ')}`);
  }
  if (drift.conflict.length > 0) {
    warn(`  Conflict (upstream updated AND user edited — merge): ${drift.conflict.join(', ')}`);
  }
  if (drift.upstreamUpdated.length > 0) {
    warn(`  Upstream template updates: ${drift.upstreamUpdated.join(', ')}`);
  }
  if (drift.userAdapted.length > 0) {
    info(
      `  Adapted locally (current with upstream — finalize to bless): ${drift.userAdapted.join(', ')}`,
    );
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
  if (drift.agentSlotMismatch) {
    warn(
      `  Agent slot limits disagree: stages.json ${drift.agentSlotMismatch.stages.min}–${drift.agentSlotMismatch.stages.max}, harness.env ${drift.agentSlotMismatch.env.min}–${drift.agentSlotMismatch.env.max}`,
    );
    warn('  Canonical source is .har/stages.json — har env maintain --finalize syncs harness.env.');
  }
  if (
    drift.conflict.length === 0 &&
    drift.upstreamUpdated.length === 0 &&
    drift.missing.length === 0 &&
    drift.extra.length === 0 &&
    drift.missingPortVars.length === 0 &&
    !drift.agentSlotMismatch
  ) {
    success(
      drift.userAdapted.length > 0
        ? '  No actionable drift (local adaptations are current with upstream)'
        : '  Harness matches bundled templates',
    );
  }
}

function printMaintainBundleSummary(report: MaintainBundleReport): void {
  const missing = report.actions.filter((a) => a.kind === 'missing').length;
  const upstream = report.actions.filter((a) => a.kind === 'upstream-updated').length;
  const conflicts = report.actions.filter((a) => a.kind === 'conflict').length;
  const pluginMissing = report.pluginActions.filter((a) => a.kind === 'missing').length;
  const pluginDrifted = report.pluginActions.filter((a) => a.kind === 'drift').length;
  const stale = report.stale.length;
  info(`Maintenance bundle: .har/maintain/`);
  info(
    `  Harness: ${missing} missing, ${upstream} upstream-updated, ${conflicts} conflict(s), ${report.adapted.length} adapted (no action), ${stale} stale`,
  );
  if (report.pluginDrift.length > 0) {
    info(
      `  Plugins (${report.pluginDrift.map((p) => p.pluginId).join(', ')}): ${pluginMissing} missing, ${pluginDrifted} drifted`,
    );
  }
  if (!report.validation.pass) {
    warn(`  Validation: ${report.validation.errors.length} error(s) — blocks --finalize`);
  }
}

/** Loud pre-1.0 → 1.0 migration report (#241). */
function printMigrationSummary(migration: MaintainMigrationInfo): void {
  divider();
  if (migration.applied) {
    const applied = migration.appliedResult;
    success(`Migration applied: ${migration.title}`);
    if (applied) {
      if (applied.written.length > 0) info(`  Rewritten: ${applied.written.join(', ')}`);
      if (applied.deleted.length > 0) info(`  Removed:   ${applied.deleted.join(', ')}`);
      info(`  Backups:   .har/migrate/backup/`);
    }
    info(`  Manifest stamped runtimeVersion=${migration.to}`);
    if (migration.plan.residue.length > 0) {
      warn(
        `  ${migration.plan.residue.length} adapted item(s) need lifting into config/stages/hooks/plugins — see .har/MIGRATE-PROMPT.md`,
      );
    }
  } else {
    warn(`PRE-1.0 HARNESS DETECTED — migration available: ${migration.title}`);
    warn('  Your vendored .har/*.sh scripts keep working for now (deprecated, compat window).');
    info(`  Plan:    .har/migrate/plan.json`);
    info(`  Prompt:  .har/MIGRATE-PROMPT.md (paste into your coding agent)`);
    info(`  Apply mechanical steps: har env maintain --migrate`);
  }
}

function printNextSteps(): void {
  console.error('');
  console.error('  Read:         .har/README.md');
  console.error('  Adapt:        paste clipboard / prompt above into your coding agent');
  console.error('  Prompt file:  .har/ADAPT-PROMPT.md');
  console.error('  Setup infra:  ./.har/setup-infra.sh   # when Docker infra is enabled');
  console.error('  Launch:       har env launch 1        # preferred; or ./.har/launch.sh 1');
  console.error('  Verify:       har env verify 1         # preferred; or ./.har/verify.sh 1');
  console.error('  Maintain:     har env maintain');
  console.error('  MCP server:   har mcp');
  console.error('');
}
