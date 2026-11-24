import * as path from 'path';
import type { Argv } from 'yargs';
import {
  checkCommitGate,
  getHooksStatus,
  installHooks,
  recordCommitAssociation,
  recordCommitTrailers,
  uninstallHooks,
} from '../../core/hooks';
import {
  CLAUDE_GUARD_RELATIVE_PATH,
  claudeGuardInstalled,
  installClaudeGuard,
  uninstallClaudeGuard,
} from '../../core/claude-hooks';
import { error, info, success, warn } from '../../utils/logging';
import { describeFactoryProofBin, FACTORY_PROOF_MIN_VERSION, FACTORY_PROOF_UNAVAILABLE_HINT } from '../../core/proof';

interface RepoArgs {
  repo: string;
}

function repoOption(y: Argv) {
  return y.option('repo', { type: 'string', default: '.', describe: 'Path to the repository' });
}

function handleInstall(argv: RepoArgs & { force: boolean; claude: boolean }): void {
  try {
    if (argv.claude) {
      const result = installClaudeGuard(path.resolve(argv.repo));
      success('Claude Code worktree guard installed.');
      info(`Guard script:  ${result.guardScript}`);
      info(`Settings:      ${result.settingsPath} (PreToolUse: Edit|Write|MultiEdit|NotebookEdit)`);
      info('File edits in the MAIN checkout are now blocked with a pointer to /har-wt.');
      info('Commit both files so the guard travels with the repo.');
      return;
    }
    const result = installHooks({ repoPath: path.resolve(argv.repo), force: argv.force });
    success(`Commit gate installed in ${result.hooksDir}`);
    info(
      `pre-commit: ${result.preCommit}, post-commit: ${result.postCommit}${result.commitMsg ? `, commit-msg: ${result.commitMsg}` : ''}`,
    );
    if (result.factoryProof) {
      info(`Factory Commits proofs: ${result.factoryProof.mode}`);
      if (result.factoryProof.setup) {
        (result.factoryProof.setup.status === 'attested' ? info : warn)(result.factoryProof.setup.message);
      }
    }
    info('Commits of unverified change batches will be blocked in agent worktrees.');
    info('Run `har env verify <agentId> --full` to validate a batch before committing.');
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

function handleUninstall(argv: RepoArgs & { claude: boolean }): void {
  try {
    if (argv.claude) {
      const result = uninstallClaudeGuard(path.resolve(argv.repo));
      if (result.removed) {
        success('Claude Code worktree guard removed.');
      } else {
        info('No Claude Code worktree guard was installed.');
      }
      return;
    }
    const result = uninstallHooks(path.resolve(argv.repo));
    if (result.removed) {
      success(`Commit gate removed from ${result.hooksDir}`);
    } else {
      info('No har hooks were installed.');
    }
    if (result.factoryProof?.setup) {
      (result.factoryProof.setup.status === 'attested' ? info : warn)(result.factoryProof.setup.message);
    }
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

function handleStatus(argv: RepoArgs & { json: boolean }): void {
  try {
    const status = getHooksStatus(path.resolve(argv.repo));
    if (argv.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return;
    }
    info(`Checkout:      ${status.checkout}`);
    info(`Hooks dir:     ${status.hooksDir}`);
    if (status.configuredHooksPath) {
      warn(`core.hooksPath is set (${status.configuredHooksPath}) — hooks are managed externally`);
    }
    info(`pre-commit:    ${status.preCommitInstalled ? 'installed' : 'not installed'}`);
    info(`post-commit:   ${status.postCommitInstalled ? 'installed' : 'not installed'}`);
    if ((status.factoryProofModeSource === 'harness.env' && status.factoryProofMode !== 'off') || status.commitMsgInstalled) {
      info(`commit-msg:    ${status.commitMsgInstalled ? 'installed' : 'not installed'} (factory trailers)`);
      info(`Factory proof: ${status.factoryProofMode} (HAR_FACTORY_PROOF in .har/harness.env)`);
    } else if (status.factoryProofModeSource === 'default') {
      info(`Factory proof: ${status.factoryProofMode} (default: local notes when git factory is installed)`);
    }
    if (status.factoryProofMode !== 'off') {
      const factoryBin = describeFactoryProofBin();
      if (factoryBin.status === 'ok') {
        info(`git factory:   ${factoryBin.version} (${factoryBin.bin})`);
      } else if (factoryBin.status === 'unsupported') {
        warn(
          `git factory:   ${factoryBin.version ?? 'unknown version'} at ${factoryBin.bin} is too old — ` +
            `no proofs are written until it is ${FACTORY_PROOF_MIN_VERSION} or newer`,
        );
      } else {
        warn(`git factory:   ${FACTORY_PROOF_UNAVAILABLE_HINT}; no proofs are written`);
      }
    }
    info(
      `Gate:          enabled=${status.gate.enabled} mode=${status.gate.mode} scope=${status.gate.scope}`,
    );
    info(`Effective:     ${status.effectiveMode} (in this checkout)`);
    info(
      `Claude guard:  ${claudeGuardInstalled(path.resolve(argv.repo)) ? `installed (${CLAUDE_GUARD_RELATIVE_PATH})` : 'not installed'}`,
    );
  } catch (err) {
    error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

function handleCheck(): void {
  const result = checkCommitGate(process.cwd());
  for (const message of result.messages) {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = result.exitCode;
}

async function handleRecordCommit(): Promise<void> {
  const result = await recordCommitAssociation(process.cwd());
  if (result.proof) process.stderr.write(`${result.proof.message}\n`);
}

function handleCommitMsg(argv: { file: string }): void {
  const outcome = recordCommitTrailers(process.cwd(), argv.file);
  if (outcome && outcome.status !== 'attested') process.stderr.write(`${outcome.message}\n`);
  process.exitCode = 0;
}

export const hooksCommand = {
  command: 'hooks <subcommand>',
  describe: 'Git commit gate: block commits of unverified change batches',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'install',
        'Install the pre-commit/post-commit gate into this repo (covers all worktrees)',
        (y: Argv) =>
          repoOption(y)
            .option('force', {
              type: 'boolean',
              default: false,
              describe: 'Write hooks even when core.hooksPath points at a managed directory',
            })
            .option('claude', {
              type: 'boolean',
              default: false,
              describe:
                'Install the Claude Code worktree guard instead (blocks Edit/Write in the main checkout, points to /har-wt)',
            }),
        handleInstall,
      )
      .command(
        'uninstall',
        'Remove the har commit gate hooks',
        (y: Argv) =>
          repoOption(y).option('claude', {
            type: 'boolean',
            default: false,
            describe: 'Remove the Claude Code worktree guard instead',
          }),
        handleUninstall,
      )
      .command(
        'status',
        'Show hook installation and gate configuration',
        (y: Argv) => repoOption(y).option('json', { type: 'boolean', default: false }),
        handleStatus,
      )
      .command(
        'check',
        'Pre-commit worker: verify the staged change batch (exit 1 = block)',
        () => {},
        handleCheck,
      )
      .command(
        'commit-msg <file>',
        'commit-msg worker: add Factory Commits trailers (HAR_FACTORY_PROOF=notes+trailers only; never fails)',
        (y: Argv) => y.positional('file', { type: 'string', demandOption: true, describe: 'Commit message file' }),
        (argv) => handleCommitMsg(argv as unknown as { file: string }),
      )
      .command(
        'record-commit',
        'Post-commit worker: associate the new commit with its validation',
        () => {},
        handleRecordCommit,
      )
      .demandCommand(1, 'Specify a subcommand. Try: har hooks install'),
  handler: () => {},
};
