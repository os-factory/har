import * as path from 'path';
import type { Argv } from 'yargs';
import { z } from 'zod';
import {
  FACTORY_PROOF_LEVELS,
  FactoryProofQueryResult,
  runFactoryProofQuery,
} from '../../core/proof';
import { error, info, warn } from '../../utils/logging';

const ProofArgsSchema = z.object({
  repo: z.string().default('.'),
  rev: z.string().optional(),
  json: z.boolean().default(false),
  minLevel: z.enum(FACTORY_PROOF_LEVELS).optional(),
  allowedSigners: z.string().optional(),
});

interface ProblemShape {
  code?: string;
  message?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function short(sha: unknown): string {
  return typeof sha === 'string' ? sha.slice(0, 12) : '?';
}

function summarizeVerify(result: unknown): void {
  const commits = asRecord(result)?.commits;
  if (!Array.isArray(commits) || commits.length === 0) {
    info('No commits verified.');
    return;
  }
  for (const entry of commits) {
    const commit = asRecord(entry) ?? {};
    const problems = Array.isArray(commit.problems) ? (commit.problems as ProblemShape[]) : [];
    info(`${short(commit.commit)}  level ${String(commit.level ?? 'none')}${problems.length ? `  (${problems.length} problem${problems.length === 1 ? '' : 's'})` : ''}`);
    for (const problem of problems) {
      warn(`  ${problem.code ?? 'PROBLEM'}: ${problem.message ?? ''}`);
    }
  }
}

function summarizeShow(result: unknown): void {
  const shown = asRecord(result) ?? {};
  info(`Commit: ${String(shown.commit ?? '?')}`);
  info(`Tree:   ${String(shown.tree ?? '?')}`);
  const trailers = asRecord(shown.trailers) ?? {};
  for (const [name, value] of Object.entries(trailers)) {
    info(`${name}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  }
  const note = asRecord(shown.note);
  if (!note) {
    info('No factory note on this commit.');
    return;
  }
  const attestations = Array.isArray(note.attestations) ? note.attestations : [];
  info(`Factory note: ${attestations.length} attestation${attestations.length === 1 ? '' : 's'}`);
  for (const attestation of attestations) {
    const entry = asRecord(attestation) ?? {};
    info(`  ${String(entry.digest ?? '?')}  ${String(entry.predicateType ?? '')}`);
  }
}

function report(command: 'show' | 'verify', json: boolean, result: FactoryProofQueryResult): void {
  if (json && result.available && result.stdout) {
    process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
  } else if (result.result !== null) {
    if (command === 'verify') summarizeVerify(result.result);
    else summarizeShow(result.result);
  }
  if (result.code !== 0 && result.stderr.trim()) {
    error(`git factory ${command}: ${result.stderr.trim().split('\n')[0]}`);
  }
}

function handle(command: 'show' | 'verify', raw: unknown): void {
  const argv = ProofArgsSchema.parse(raw);
  const result = runFactoryProofQuery({
    repoPath: path.resolve(argv.repo),
    command,
    rev: argv.rev,
    minLevel: argv.minLevel,
    allowedSigners: argv.allowedSigners,
  });
  report(command, argv.json, result);
  process.exitCode = result.code;
}

function common(y: Argv) {
  return y
    .option('repo', { type: 'string', default: '.', describe: 'Path to the repository' })
    .option('json', { type: 'boolean', default: false, describe: 'Pass git factory --json output through' });
}

export const proofCommand = {
  command: 'proof <subcommand>',
  describe: 'Factory Commits proofs: show or verify them (wraps the git-factory executable)',
  builder: (yargs: Argv) =>
    yargs
      .command(
        'show [rev]',
        'Show the factory note and trailers on a commit (default HEAD)',
        (y: Argv) => common(y).positional('rev', { type: 'string', describe: 'Commit (default HEAD)' }),
        (argv) => handle('show', argv),
      )
      .command(
        'verify [rev]',
        'Verify Factory Commits proofs on a commit or a range (A..B); exit 1 when below --min-level',
        (y: Argv) =>
          common(y)
            .positional('rev', { type: 'string', describe: 'Commit or range A..B (default HEAD)' })
            .option('min-level', { type: 'string', choices: [...FACTORY_PROOF_LEVELS], describe: 'Minimum level' })
            .option('allowed-signers', { type: 'string', describe: 'ssh allowed_signers file for L2' }),
        (argv) => handle('verify', argv),
      )
      .demandCommand(1, 'Specify a subcommand. Try: har proof verify'),
  handler: () => {},
};
