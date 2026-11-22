import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { readHarnessEnv } from '../harness/env';
import { getHarnessDir } from '../harness/manifest';
import { HarnessStageRegistry, ValidationRecord, VerificationResult } from '../harness/schema';
import { readStageRegistry } from '../harness/stages';
import { resolveVerificationPlan } from '../harness/verification';
import { getHarPackageVersion } from './package-version';
import { findValidation, setValidationAttestationDigest } from './validations';
import { findWorkUnit, listValidationBindings } from './work-units';

/**
 * HAR as a Factory Commits producer (https://github.com/os-factory/factory-commits).
 *
 * HAR only builds the `factory-run` *predicate* from its own records. Every
 * other part of the standard — statement, DSSE envelope, digest, notes,
 * trailers, verification — belongs to the external `git-factory` executable,
 * called through its CLI contract (packages/factory-proof/CLI.md). Nothing
 * here may block verify, commit or launch: every failure is reported as an
 * outcome, never thrown.
 */

export const FACTORY_PROOF_MODES = ['off', 'notes', 'notes+trailers'] as const;
export type FactoryProofMode = (typeof FACTORY_PROOF_MODES)[number];

/** harness.env key opting a repository in. */
export const FACTORY_PROOF_ENV_KEY = 'HAR_FACTORY_PROOF';
/** Explicit path to a `git-factory` executable (wins over PATH). */
export const FACTORY_PROOF_BIN_ENV = 'HAR_FACTORY_PROOF_BIN';
export const FACTORY_PROOF_EXECUTABLE = 'git-factory';

export const FACTORY_RUN_PREDICATE_TYPE = 'https://os-factory.dev/factory-commits/factory-run/v0.1';
/** Policy id recorded for `har env verify --full`: the stages in verificationStages. */
export const FACTORY_PROOF_POLICY_ID = 'har-verify-full';

const ATTESTATION_SUFFIX = '.attestation.json';
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const SOURCE_RE = /^[a-z0-9][a-z0-9-]*$/;
const TOKEN_RE = /^[^\s;]+$/;
const CALL_TIMEOUT_MS = 60_000;

/**
 * Mode used when `HAR_FACTORY_PROOF` is unset (HAR 2.0.0): local notes, written
 * only when `git factory` is installed. Under the default HAR never prints a
 * hint about a missing binary and `har hooks install` leaves git config alone.
 */
export const DEFAULT_FACTORY_PROOF_MODE: FactoryProofMode = 'notes';

export interface FactoryProofModeResolution {
  mode: FactoryProofMode;
  /** True when `HAR_FACTORY_PROOF` is set in harness.env (the user chose the mode). */
  explicit: boolean;
}

/**
 * Resolve the per-repo mode. Unset or empty → the default (`notes`, not
 * explicit). A set value that is not a known mode means `off`, as in 1.x. An
 * unreadable harness.env means `off`.
 */
export function resolveFactoryProofMode(harnessRoot: string): FactoryProofModeResolution {
  let raw: string | undefined;
  try {
    raw = readHarnessEnv(harnessRoot)[FACTORY_PROOF_ENV_KEY];
  } catch {
    return { mode: 'off', explicit: false };
  }
  const value = raw?.trim();
  if (!value) return { mode: DEFAULT_FACTORY_PROOF_MODE, explicit: false };
  return {
    mode: (FACTORY_PROOF_MODES as readonly string[]).includes(value) ? (value as FactoryProofMode) : 'off',
    explicit: true,
  };
}

/** The effective mode (see `resolveFactoryProofMode`). */
export function readFactoryProofMode(harnessRoot: string): FactoryProofMode {
  return resolveFactoryProofMode(harnessRoot).mode;
}

function isExecutable(file: string): boolean {
  try {
    if (!fs.statSync(file).isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * `HAR_FACTORY_PROOF_BIN` → `git-factory` on PATH → undefined (unavailable).
 * An explicit HAR_FACTORY_PROOF_BIN that is not executable is unavailable too:
 * silently falling back to another binary would hide a misconfiguration.
 */
export function resolveFactoryProofBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = env[FACTORY_PROOF_BIN_ENV]?.trim();
  if (explicit) return isExecutable(explicit) ? path.resolve(explicit) : undefined;

  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, FACTORY_PROOF_EXECUTABLE);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export const FACTORY_PROOF_UNAVAILABLE_HINT =
  `git-factory not found — install factory-proof or set ${FACTORY_PROOF_BIN_ENV}`;

export interface FactoryProofCall {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run `git-factory <args>` (equivalent to `git factory <args>`). Never throws. */
export function callFactoryProof(
  bin: string,
  args: string[],
  options: { cwd: string; input?: string; env?: NodeJS.ProcessEnv },
): FactoryProofCall {
  try {
    const child = spawnSync(bin, args, {
      cwd: options.cwd,
      input: options.input,
      env: { ...process.env, ...options.env },
      encoding: 'utf8',
      timeout: CALL_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (child.error) {
      return { code: 2, stdout: child.stdout ?? '', stderr: child.error.message };
    }
    return { code: child.status ?? 2, stdout: child.stdout ?? '', stderr: child.stderr ?? '' };
  } catch (err) {
    return { code: 2, stdout: '', stderr: err instanceof Error ? err.message : String(err) };
  }
}

/** First non-empty stderr line, for one-line fail-open messages. */
export function firstLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

// ---------------------------------------------------------------------------
// Predicate mapping
// ---------------------------------------------------------------------------

export type FactoryStageStatus = 'passed' | 'failed' | 'error' | 'skipped';

export interface FactoryRunPredicate {
  run: { id: string; startedOn?: string; finishedOn?: string };
  workUnit?: { id: string; source?: string; attemptId?: string };
  policy: { id: string; digest?: { sha256: string }; required: string[] };
  stages: Array<{
    id: string;
    status: FactoryStageStatus;
    addedBy?: 'policy' | 'agent';
    kind?: string;
    durationMs?: number;
  }>;
  verdict: 'pass' | 'fail';
  producer: { name: string; version: string };
  environment: { trust: 'local' | 'ci'; executor?: string };
  /** OTel trace of the verification run (telemetry profile); only when that trace is exported. */
  telemetry?: { traceId: string };
}

export interface BuildFactoryRunPredicateInput {
  validation: Pick<ValidationRecord, 'validationId'>;
  verification: VerificationResult;
  registry: HarnessStageRegistry;
  /** sha256 hex of the stages.json bytes the policy came from, when known. */
  policyDigest?: string;
  run?: { startedAt?: string; finishedAt?: string };
  workUnit?: { id: string; source?: string; attemptId?: string };
  producerVersion: string;
  /** Set only when the verification trace will actually be exported. */
  telemetry?: { traceId: string };
  env?: NodeJS.ProcessEnv;
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;

/** The verify-runner's marker for a registered stage that cannot run at all. */
const UNRUNNABLE_STAGE_OUTPUT = 'stage has neither script nor command';

function isCi(env: NodeJS.ProcessEnv): boolean {
  const value = env.CI?.trim().toLowerCase();
  return Boolean(value) && value !== 'false' && value !== '0';
}

function toRfc3339(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * SPEC §4.3: `pass` iff every required stage id appears with status `passed`.
 * Recomputed from the predicate itself, never copied from HAR's own status.
 */
export function computeFactoryVerdict(
  required: readonly string[],
  stages: FactoryRunPredicate['stages'],
): 'pass' | 'fail' {
  const passed = new Set(stages.filter((s) => s.status === 'passed').map((s) => s.id));
  return required.every((id) => passed.has(id)) ? 'pass' : 'fail';
}

/**
 * Map one full HAR validation to a Factory Commits `factory-run` predicate.
 * Privacy (SPEC §6): no absolute paths, prompts, stage output, work-unit
 * titles or URLs.
 */
export function buildFactoryRunPredicate(input: BuildFactoryRunPredicateInput): FactoryRunPredicate {
  const env = input.env ?? process.env;
  const plan = resolveVerificationPlan(input.registry, { full: true });
  const required = [...new Set(plan.steps.map((stage) => stage.id))];
  const requiredSet = new Set(required);
  const kindById = new Map(input.registry.stages.map((stage) => [stage.id, stage.kind]));

  const stages: FactoryRunPredicate['stages'] = [];
  const seen = new Set<string>();
  for (const step of input.verification.stages) {
    if (seen.has(step.name)) continue;
    seen.add(step.name);
    const status: FactoryStageStatus = step.pass
      ? 'passed'
      : step.output === UNRUNNABLE_STAGE_OUTPUT
        ? 'error'
        : 'failed';
    const kind = kindById.get(step.name);
    stages.push({
      id: step.name,
      status,
      addedBy: requiredSet.has(step.name) ? 'policy' : 'agent',
      ...(kind ? { kind } : {}),
      ...(typeof step.ms === 'number' && Number.isFinite(step.ms)
        ? { durationMs: Math.max(0, Math.round(step.ms)) }
        : {}),
    });
  }

  const startedOn = toRfc3339(input.run?.startedAt);
  const finishedOn = toRfc3339(input.run?.finishedAt);

  let workUnit: FactoryRunPredicate['workUnit'];
  if (input.workUnit && TOKEN_RE.test(input.workUnit.id)) {
    workUnit = { id: input.workUnit.id };
    if (input.workUnit.source && SOURCE_RE.test(input.workUnit.source)) {
      workUnit.source = input.workUnit.source;
    }
    if (input.workUnit.attemptId && TOKEN_RE.test(input.workUnit.attemptId)) {
      workUnit.attemptId = input.workUnit.attemptId;
    }
  }

  const ci = isCi(env);
  const executor = env.GITHUB_ACTIONS === 'true' ? 'github-actions' : ci ? undefined : 'local';

  return {
    run: {
      id: input.validation.validationId,
      ...(startedOn ? { startedOn } : {}),
      ...(finishedOn ? { finishedOn } : {}),
    },
    ...(workUnit ? { workUnit } : {}),
    policy: {
      id: FACTORY_PROOF_POLICY_ID,
      ...(input.policyDigest ? { digest: { sha256: input.policyDigest } } : {}),
      required,
    },
    stages,
    verdict: computeFactoryVerdict(required, stages),
    producer: { name: 'har', version: input.producerVersion },
    environment: { trust: ci ? 'ci' : 'local', ...(executor ? { executor } : {}) },
    ...(input.telemetry && TRACE_ID_RE.test(input.telemetry.traceId)
      ? { telemetry: { traceId: input.telemetry.traceId } }
      : {}),
  };
}

/** sha256 hex of `.har/stages.json`, the file the verify policy is read from. */
export function readPolicyDigest(harnessRoot: string): string | undefined {
  try {
    const bytes = fs.readFileSync(path.join(getHarnessDir(harnessRoot), 'stages.json'));
    return crypto.createHash('sha256').update(bytes).digest('hex');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Attestation files (gitignored, next to the validation record)
// ---------------------------------------------------------------------------

/** `<checkout>/.har/validations/<tree>.attestation.json` */
export function attestationFilePath(checkoutDir: string, treeHash: string): string {
  return path.join(checkoutDir, '.har', 'validations', `${treeHash}${ATTESTATION_SUFFIX}`);
}

export interface FactoryAttestationEntry {
  predicateType: string;
  digest: string;
  envelope: unknown;
}

/** Read an attestation entry (as written by `attest --out`), or undefined. */
export function readAttestationEntry(file: string): FactoryAttestationEntry | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<FactoryAttestationEntry>;
    if (typeof parsed.digest !== 'string' || !DIGEST_RE.test(parsed.digest)) return undefined;
    if (typeof parsed.predicateType !== 'string') return undefined;
    return parsed as FactoryAttestationEntry;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Producing the attestation for a validation
// ---------------------------------------------------------------------------

export interface FactoryProofOutcome {
  status: 'attested' | 'skipped' | 'failed';
  /** One line, safe to print. */
  message: string;
  digest?: string;
  attestationFile?: string;
}

export interface AttestValidationInput {
  harnessRoot: string;
  checkoutDir: string;
  predicate: FactoryRunPredicate;
  treeHash: string;
  /** Overrides binary resolution (tests). */
  bin?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * `git factory attest --predicate - --tree <tree> --out <file> --json`, then
 * mirror the entry to the harness root. Fail-open: returns an outcome.
 */
export function attestFactoryRun(input: AttestValidationInput): FactoryProofOutcome {
  const bin = input.bin ?? resolveFactoryProofBin(input.env);
  if (!bin) return { status: 'skipped', message: `Factory Commits proof skipped: ${FACTORY_PROOF_UNAVAILABLE_HINT}` };

  const outFile = attestationFilePath(input.checkoutDir, input.treeHash);
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.rmSync(outFile, { force: true });
  } catch {
    // the attest call reports the real problem
  }

  const call = callFactoryProof(
    bin,
    ['attest', '--predicate', '-', '--tree', input.treeHash, '--out', outFile, '--json'],
    { cwd: input.checkoutDir, input: JSON.stringify(input.predicate), env: input.env },
  );
  if (call.code !== 0) {
    const detail = firstLine(call.stderr);
    return {
      status: 'failed',
      message: `Factory Commits proof not recorded: git factory attest exited ${call.code}${detail ? ` (${detail})` : ''}`,
    };
  }

  let digest: string | undefined;
  try {
    const parsed = JSON.parse(call.stdout) as { digest?: unknown };
    if (typeof parsed.digest === 'string') digest = parsed.digest;
  } catch {
    digest = undefined;
  }
  const entry = readAttestationEntry(outFile);
  if (!digest || !DIGEST_RE.test(digest) || !entry || entry.digest !== digest) {
    return {
      status: 'failed',
      message: 'Factory Commits proof not recorded: git factory attest returned no matching attestation',
    };
  }

  if (path.resolve(input.harnessRoot) !== path.resolve(input.checkoutDir)) {
    try {
      const mirror = attestationFilePath(input.harnessRoot, input.treeHash);
      fs.mkdirSync(path.dirname(mirror), { recursive: true });
      fs.copyFileSync(outFile, mirror);
    } catch {
      // the checkout copy is the one the commit hooks read
    }
  }

  return {
    status: 'attested',
    message: `Factory Commits proof: ${digest.slice(0, 19)}… (verdict ${input.predicate.verdict})`,
    digest,
    attestationFile: outFile,
  };
}

export interface ProduceValidationProofInput {
  harnessRoot: string;
  checkoutDir: string;
  validation: ValidationRecord;
  verification: VerificationResult;
  run?: { startedAt?: string; finishedAt?: string };
  workUnit?: { id: string; source?: string; attemptId?: string };
  /** Verification trace to link from the predicate; pass only when it will be exported. */
  telemetry?: { traceId: string };
  bin?: string;
  env?: NodeJS.ProcessEnv;
}

export interface ProduceValidationProofResult {
  /**
   * Undefined when nothing was done: mode `off`, or the default mode with no
   * `git-factory` installed (silent, no hint).
   */
  outcome?: FactoryProofOutcome;
  /** The validation record, with attestationDigest when an attestation was produced. */
  validation: ValidationRecord;
}

/**
 * After a full validation is recorded: build the predicate, attest it and store
 * the digest on the record. Mode `off` is a no-op that touches nothing, and so
 * is the default mode when `git-factory` is not installed. Never throws.
 */
export function produceValidationProof(input: ProduceValidationProofInput): ProduceValidationProofResult {
  try {
    const { mode, explicit } = resolveFactoryProofMode(input.harnessRoot);
    if (mode === 'off') return { validation: input.validation };
    const bin = input.bin ?? resolveFactoryProofBin(input.env);
    // Under the default, a missing binary is not worth a line on every verify.
    if (!bin && !explicit) return { validation: input.validation };

    const predicate = buildFactoryRunPredicate({
      validation: input.validation,
      verification: input.verification,
      registry: readStageRegistry(input.harnessRoot),
      policyDigest: readPolicyDigest(input.harnessRoot),
      run: input.run,
      workUnit: input.workUnit,
      producerVersion: getHarPackageVersion(),
      telemetry: input.telemetry,
      env: input.env,
    });
    const outcome = attestFactoryRun({
      harnessRoot: input.harnessRoot,
      checkoutDir: input.checkoutDir,
      predicate,
      treeHash: input.validation.treeHash,
      bin,
      env: input.env,
    });
    if (outcome.status !== 'attested' || !outcome.digest) return { outcome, validation: input.validation };

    const updated = setValidationAttestationDigest(
      input.checkoutDir,
      input.harnessRoot,
      input.validation.treeHash,
      outcome.digest,
    );
    return { outcome, validation: updated ?? input.validation };
  } catch (err) {
    return {
      outcome: {
        status: 'failed',
        message: `Factory Commits proof not recorded: ${firstLine(err instanceof Error ? err.message : String(err))}`,
      },
      validation: input.validation,
    };
  }
}

// ---------------------------------------------------------------------------
// Commit-time hooks (post-commit note, commit-msg trailers, git config setup)
// ---------------------------------------------------------------------------

export function proofModeIncludesNotes(mode: FactoryProofMode): boolean {
  return mode === 'notes' || mode === 'notes+trailers';
}

/**
 * The attestation entry file for a passing full validation of `treeHash`,
 * when one exists and still matches the digest on the record.
 */
export function findPassingAttestation(
  checkoutDir: string,
  treeHash: string,
): { validation: ValidationRecord; file: string; digest: string } | undefined {
  const validation = findValidation(checkoutDir, treeHash);
  if (!validation || validation.status !== 'pass' || !validation.full) return undefined;
  if (!validation.attestationDigest) return undefined;
  const file = attestationFilePath(checkoutDir, treeHash);
  const entry = readAttestationEntry(file);
  if (!entry || entry.digest !== validation.attestationDigest) return undefined;
  return { validation, file, digest: entry.digest };
}

/**
 * post-commit: `git factory note add HEAD --attestation <file>` when the repo
 * opted in (mode ≥ notes) and HEAD's tree has a passing attested validation.
 * Returns a one-line message, or undefined when there was nothing to do.
 */
export function addFactoryNoteForCommit(
  checkoutDir: string,
  treeHash: string,
  options: { bin?: string; env?: NodeJS.ProcessEnv } = {},
): FactoryProofOutcome | undefined {
  try {
    const { mode, explicit } = resolveFactoryProofMode(checkoutDir);
    if (!proofModeIncludesNotes(mode)) return undefined;
    const attestation = findPassingAttestation(checkoutDir, treeHash);
    if (!attestation) return undefined;
    const bin = options.bin ?? resolveFactoryProofBin(options.env);
    if (!bin) {
      return explicit
        ? { status: 'skipped', message: `har: factory note skipped: ${FACTORY_PROOF_UNAVAILABLE_HINT}` }
        : undefined;
    }
    const call = callFactoryProof(bin, ['note', 'add', 'HEAD', '--attestation', attestation.file, '--json'], {
      cwd: checkoutDir,
      env: options.env,
    });
    if (call.code !== 0) {
      const detail = firstLine(call.stderr);
      return {
        status: 'failed',
        message: `har: factory note not written (git factory note add exited ${call.code}${detail ? `: ${detail}` : ''})`,
      };
    }
    return {
      status: 'attested',
      message: `har: factory note ${attestation.digest.slice(0, 19)}… added to HEAD`,
      digest: attestation.digest,
      attestationFile: attestation.file,
    };
  } catch (err) {
    return { status: 'failed', message: `har: factory note not written (${firstLine(String(err))})` };
  }
}

/** `[source:]id` for the Work-Unit trailer, from HAR's own validation bindings. */
function workUnitTrailerValue(validation: ValidationRecord, checkoutDir: string): string | undefined {
  const roots = [validation.harnessRoot, checkoutDir].filter(
    (root, index, all) => root && all.indexOf(root) === index && fs.existsSync(path.join(root, '.har')),
  );
  for (const root of roots) {
    const binding = listValidationBindings(root).find((b) => b.validationId === validation.validationId);
    if (!binding) continue;
    if (!TOKEN_RE.test(binding.workUnitId)) return undefined;
    const source = findWorkUnit(root, binding.workUnitId)?.source;
    if (source && SOURCE_RE.test(source)) return `${source}:${binding.workUnitId}`;
    // An id containing ':' would be read as `source:id`; omit rather than mislabel.
    return binding.workUnitId.includes(':') ? undefined : binding.workUnitId;
  }
  return undefined;
}

/**
 * commit-msg: add Factory trailers for the tree being committed when the repo
 * opted in to `notes+trailers` and that tree has a passing full validation.
 * Never fails the commit.
 */
export function addFactoryTrailers(
  checkoutDir: string,
  messageFile: string,
  treeHash: string,
  options: { bin?: string; env?: NodeJS.ProcessEnv } = {},
): FactoryProofOutcome | undefined {
  try {
    if (readFactoryProofMode(checkoutDir) !== 'notes+trailers') return undefined;
    const validation = findValidation(checkoutDir, treeHash);
    if (!validation || validation.status !== 'pass' || !validation.full) return undefined;
    const bin = options.bin ?? resolveFactoryProofBin(options.env);
    if (!bin) return { status: 'skipped', message: `har: factory trailers skipped: ${FACTORY_PROOF_UNAVAILABLE_HINT}` };

    const args = ['trailers', messageFile];
    const workUnit = workUnitTrailerValue(validation, checkoutDir);
    if (workUnit) args.push('--work-unit', workUnit);
    args.push('--run', validation.validationId);
    const attestation = findPassingAttestation(checkoutDir, treeHash);
    if (attestation) args.push('--attestation', attestation.digest);

    const call = callFactoryProof(bin, args, { cwd: checkoutDir, env: options.env });
    if (call.code !== 0) {
      const detail = firstLine(call.stderr);
      return {
        status: 'failed',
        message: `har: factory trailers not added (git factory trailers exited ${call.code}${detail ? `: ${detail}` : ''})`,
      };
    }
    return { status: 'attested', message: 'har: factory trailers added' };
  } catch (err) {
    return { status: 'failed', message: `har: factory trailers not added (${firstLine(String(err))})` };
  }
}

/** `git factory setup [--undo]` — notes fetch refspec + notes.rewriteRef. Never throws. */
export function runFactoryProofSetup(
  checkoutDir: string,
  options: { undo?: boolean; bin?: string; env?: NodeJS.ProcessEnv } = {},
): FactoryProofOutcome {
  const bin = options.bin ?? resolveFactoryProofBin(options.env);
  const label = options.undo ? 'git factory setup --undo' : 'git factory setup';
  if (!bin) return { status: 'skipped', message: `${label} skipped: ${FACTORY_PROOF_UNAVAILABLE_HINT}` };
  const call = callFactoryProof(bin, options.undo ? ['setup', '--undo'] : ['setup'], {
    cwd: checkoutDir,
    env: options.env,
  });
  if (call.code !== 0) {
    const detail = firstLine(call.stderr);
    return { status: 'failed', message: `${label} exited ${call.code}${detail ? `: ${detail}` : ''}` };
  }
  return { status: 'attested', message: `${label}: done` };
}

// ---------------------------------------------------------------------------
// Read-only queries: `har proof show|verify` and the matching MCP tools
// ---------------------------------------------------------------------------

export const FACTORY_PROOF_LEVELS = ['L0', 'L1', 'L2', 'L3'] as const;
export type FactoryProofLevel = (typeof FACTORY_PROOF_LEVELS)[number];

export interface FactoryProofQueryInput {
  repoPath: string;
  command: 'show' | 'verify';
  /** A rev for show/verify, or an `A..B` range for verify. */
  rev?: string;
  minLevel?: FactoryProofLevel;
  allowedSigners?: string;
  bin?: string;
  env?: NodeJS.ProcessEnv;
}

export interface FactoryProofQueryResult {
  /** False when no git-factory executable was found. */
  available: boolean;
  /** git-factory's exit code (0 ok, 1 verification failed, 2 usage/environment); 2 when unavailable. */
  code: number;
  /** Raw `--json` stdout from git-factory, passed through untouched. */
  stdout: string;
  stderr: string;
  /** Parsed `--json` output, or null when it was not JSON. */
  result: unknown;
}

/**
 * Pass `git factory show|verify … --json` through. HAR adds nothing to the
 * verification itself; exit codes are git-factory's.
 */
export function runFactoryProofQuery(input: FactoryProofQueryInput): FactoryProofQueryResult {
  const bin = input.bin ?? resolveFactoryProofBin(input.env);
  if (!bin) {
    return { available: false, code: 2, stdout: '', stderr: FACTORY_PROOF_UNAVAILABLE_HINT, result: null };
  }
  if (input.rev?.startsWith('-')) {
    return { available: true, code: 2, stdout: '', stderr: `invalid revision: ${input.rev}`, result: null };
  }
  const args: string[] = [input.command];
  if (input.rev) args.push(input.rev);
  if (input.command === 'verify') {
    if (input.minLevel) args.push('--min-level', input.minLevel);
    if (input.allowedSigners) args.push('--allowed-signers', path.resolve(input.repoPath, input.allowedSigners));
  }
  args.push('--json');

  const call = callFactoryProof(bin, args, { cwd: input.repoPath, env: input.env });
  let result: unknown = null;
  try {
    result = call.stdout.trim() ? JSON.parse(call.stdout) : null;
  } catch {
    result = null;
  }
  return { available: true, code: call.code, stdout: call.stdout, stderr: call.stderr, result };
}
