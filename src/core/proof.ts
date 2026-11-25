import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { readHarnessEnv } from '../harness/env';
import { getHarnessDir } from '../harness/manifest';
import { HarnessStageRegistry, ValidationRecord, VerificationResult } from '../harness/schema';
import { readStageRegistry } from '../harness/stages';
import { resolveVerificationPlan } from '../harness/verification';
import { canonicalizeControlRepoPath } from './control-repo-path';
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
 * The harness root whose `harness.env` sets the mode for `dir`: the same path
 * under the main checkout when `dir` is in a linked worktree (a HAR slot), so
 * hooks, status, verify, notes and trailers all read one setting. Falls back to
 * `dir` when the main checkout has no `.har/` there.
 */
export function resolveFactoryProofModeRoot(dir: string): string {
  try {
    const main = canonicalizeControlRepoPath(dir);
    if (main !== path.resolve(dir) && fs.existsSync(getHarnessDir(main))) return main;
  } catch {
    // not a git checkout: read dir itself
  }
  return path.resolve(dir);
}

/**
 * Resolve the per-repo mode from the main checkout's harness.env (see
 * `resolveFactoryProofModeRoot`). Unset or empty → the default (`notes`, not
 * explicit). A set value that is not a known mode means `off`, as in 1.x. An
 * unreadable harness.env means `off`.
 */
export function resolveFactoryProofMode(harnessRoot: string): FactoryProofModeResolution {
  let raw: string | undefined;
  try {
    raw = readHarnessEnv(resolveFactoryProofModeRoot(harnessRoot))[FACTORY_PROOF_ENV_KEY];
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
 * Oldest factory-proof that writes and verifies Factory Commits v0.1 as HAR produces it: 0.2.0
 * renamed `environment.trust` to `self-reported | independent`, and each side rejects the other's
 * statements, so an older executable is treated as unavailable.
 */
export const FACTORY_PROOF_MIN_VERSION = '0.2.0';

const VERSION_TIMEOUT_MS = 10_000;
const versionCache = new Map<string, string | null>();

/** The version a `git-factory --version` reports (`factory-proof X.Y.Z (…)`), or null. Cached per path. */
export function readFactoryProofVersion(bin: string): string | null {
  const cached = versionCache.get(bin);
  if (cached !== undefined) return cached;
  let version: string | null = null;
  try {
    // The process environment, not a resolution env: a script executable needs the real PATH.
    const child = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: VERSION_TIMEOUT_MS });
    const match = /factory-proof\s+v?(\d+\.\d+\.\d+)/.exec(child.stdout ?? '');
    version = child.status === 0 && match ? match[1] : null;
  } catch {
    version = null;
  }
  versionCache.set(bin, version);
  return version;
}

/** True when `version` (X.Y.Z) is at least {@link FACTORY_PROOF_MIN_VERSION}. */
export function isSupportedFactoryProofVersion(version: string | null | undefined): boolean {
  if (!version) return false;
  const parse = (v: string) => v.split('.').map((part) => Number.parseInt(part, 10));
  const have = parse(version);
  const need = parse(FACTORY_PROOF_MIN_VERSION);
  for (let i = 0; i < need.length; i++) {
    const a = have[i] ?? 0;
    if (a !== need[i]) return a > need[i];
  }
  return true;
}

function findFactoryProofExecutable(env: NodeJS.ProcessEnv): string | undefined {
  const explicit = env[FACTORY_PROOF_BIN_ENV]?.trim();
  if (explicit) return isExecutable(explicit) ? path.resolve(explicit) : undefined;

  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, FACTORY_PROOF_EXECUTABLE);
    if (isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export type FactoryProofBinStatus =
  | { status: 'ok'; bin: string; version: string }
  | { status: 'unsupported'; bin: string; version: string | null }
  | { status: 'missing' };

/** Where git-factory is and whether HAR can use it (for status output). */
export function describeFactoryProofBin(env: NodeJS.ProcessEnv = process.env): FactoryProofBinStatus {
  const bin = findFactoryProofExecutable(env);
  if (!bin) return { status: 'missing' };
  const version = readFactoryProofVersion(bin);
  return isSupportedFactoryProofVersion(version) && version
    ? { status: 'ok', bin, version }
    : { status: 'unsupported', bin, version };
}

/**
 * `HAR_FACTORY_PROOF_BIN` → `git-factory` on PATH → undefined (unavailable).
 * An explicit HAR_FACTORY_PROOF_BIN that is not executable is unavailable too:
 * silently falling back to another binary would hide a misconfiguration.
 * An executable older than {@link FACTORY_PROOF_MIN_VERSION} is unavailable as well.
 */
export function resolveFactoryProofBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const found = describeFactoryProofBin(env);
  return found.status === 'ok' ? found.bin : undefined;
}

export const FACTORY_PROOF_UNAVAILABLE_HINT =
  `git-factory ${FACTORY_PROOF_MIN_VERSION} or newer not found — ` +
  `install @osfactory/factory-proof (npm i -g @osfactory/factory-proof) or set ${FACTORY_PROOF_BIN_ENV}`;

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
  /**
   * Factory Commits v0.1 (factory-proof >= 0.2.0): `independent` only when neither the run nor a
   * signing key is within the agent's reach. HAR runs as the developer, so it always writes
   * `self-reported`, in CI too (SPEC §11).
   */
  environment: { trust: 'self-reported' | 'independent'; executor?: string };
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
    environment: { trust: 'self-reported', ...(executor ? { executor } : {}) },
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
  /**
   * The note added to HEAD right away because HEAD already has the verified tree
   * (re-verify after a rebase or amend). Undefined when nothing was added.
   */
  note?: FactoryProofOutcome;
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
    // Only a passing full validation gets a note, as on commit (findPassingAttestation).
    const noteable =
      proofModeIncludesNotes(mode) &&
      input.validation.status === 'pass' &&
      input.validation.full &&
      predicate.verdict === 'pass';
    const note = noteable && outcome.attestationFile
      ? addFactoryNoteToVerifiedHead({
          checkoutDir: input.checkoutDir,
          treeHash: input.validation.treeHash,
          attestationFile: outcome.attestationFile,
          digest: outcome.digest,
          bin,
          env: input.env,
        })
      : undefined;
    return { outcome, validation: updated ?? input.validation, ...(note ? { note } : {}) };
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

export interface AddNoteToVerifiedHeadInput {
  checkoutDir: string;
  treeHash: string;
  attestationFile: string;
  digest: string;
  bin?: string;
  env?: NodeJS.ProcessEnv;
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  try {
    const child = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: CALL_TIMEOUT_MS });
    return child.status === 0 ? child.stdout.trim() : undefined;
  } catch {
    return undefined;
  }
}

const FACTORY_NOTES_REF = 'refs/notes/factory';

/**
 * True when `commit`'s factory note already holds a `factory-run` statement for
 * `treeHash` with verdict `pass`, whatever its digest. Unreadable notes count as
 * absent. Signatures are not checked: this only avoids growing the note.
 */
export function noteHasPassingAttestationForTree(cwd: string, commit: string, treeHash: string): boolean {
  const raw = gitOutput(cwd, ['notes', '--ref', FACTORY_NOTES_REF, 'show', commit]);
  if (!raw) return false;
  try {
    const note = JSON.parse(raw) as { attestations?: unknown };
    if (!Array.isArray(note.attestations)) return false;
    return note.attestations.some((entry) => {
      try {
        const attestation = entry as { predicateType?: unknown; envelope?: { payload?: unknown } };
        if (attestation.predicateType !== FACTORY_RUN_PREDICATE_TYPE) return false;
        if (typeof attestation.envelope?.payload !== 'string') return false;
        const statement = JSON.parse(Buffer.from(attestation.envelope.payload, 'base64').toString('utf8')) as {
          subject?: Array<{ digest?: { gitTree?: unknown } }>;
          predicate?: { verdict?: unknown };
        };
        return (
          statement.predicate?.verdict === 'pass' &&
          Array.isArray(statement.subject) &&
          statement.subject.some((subject) => subject.digest?.gitTree === treeHash)
        );
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

/**
 * After a passing full verify: when the checkout's HEAD already has the verified
 * tree (the work was committed, then rebased or amended, then re-verified), the
 * post-commit hook will not run again, so add the attestation to HEAD's note now.
 * Undefined when HEAD has another tree, or HEAD's note already holds a passing
 * attestation for this tree (any digest: repeated verifies do not grow the note).
 * Never throws.
 */
export function addFactoryNoteToVerifiedHead(input: AddNoteToVerifiedHeadInput): FactoryProofOutcome | undefined {
  try {
    const head = gitOutput(input.checkoutDir, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']);
    if (!head) return undefined;
    if (gitOutput(input.checkoutDir, ['rev-parse', `${head}^{tree}`]) !== input.treeHash) return undefined;
    if (noteHasPassingAttestationForTree(input.checkoutDir, head, input.treeHash)) return undefined;
    const bin = input.bin ?? resolveFactoryProofBin(input.env);
    if (!bin) return undefined;
    const call = callFactoryProof(bin, ['note', 'add', head, '--attestation', input.attestationFile, '--json'], {
      cwd: input.checkoutDir,
      env: input.env,
    });
    if (call.code !== 0) {
      const detail = firstLine(call.stderr);
      return {
        status: 'failed',
        message: `har: factory note not written to HEAD (git factory note add exited ${call.code}${detail ? `: ${detail}` : ''})`,
      };
    }
    let added = true;
    try {
      const parsed = JSON.parse(call.stdout) as { added?: unknown };
      if (parsed.added === false) added = false;
    } catch {
      // older output without JSON: assume it was added
    }
    if (!added) return undefined;
    return {
      status: 'attested',
      message: `har: factory note ${input.digest.slice(0, 19)}… added to HEAD ${head.slice(0, 12)}`,
      digest: input.digest,
      attestationFile: input.attestationFile,
    };
  } catch (err) {
    return { status: 'failed', message: `har: factory note not written to HEAD (${firstLine(String(err))})` };
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
/**
 * `har proof verify` always passes `--min-level`, this one unless overridden:
 * `git factory verify` defaults to L1 for one commit but to no minimum for a
 * range, so a range with an unproven commit would otherwise pass.
 */
export const DEFAULT_FACTORY_PROOF_MIN_LEVEL: FactoryProofLevel = 'L1';

export interface FactoryProofQueryInput {
  repoPath: string;
  command: 'show' | 'verify';
  /** A rev for show/verify, or an `A..B` range for verify. */
  rev?: string;
  /** verify only; default {@link DEFAULT_FACTORY_PROOF_MIN_LEVEL} for one commit and for a range. */
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
    args.push('--min-level', input.minLevel ?? DEFAULT_FACTORY_PROOF_MIN_LEVEL);
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
