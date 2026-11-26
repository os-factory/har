import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import {
  LOCAL_CHECKOUT_PATH_ATTR,
  destinationsForSignal,
  otlpSignalUrl,
  type TelemetryDestination,
  type VerificationResult,
} from '../harness/schema';
import {
  encodeOtlpTraces,
  OTLP_SPAN_KIND,
  OTLP_STATUS_CODE,
  type OtlpSpanInput,
} from '../utils/otlp-json';
import { getControlApiUrl, isControlEnabled } from './control-config';
import { isControlApiReachable } from './control-sync';
import { readGitRemote, sanitizeGitRemoteUrl } from './git-remote';
import { getHarPackageVersion } from './package-version';
import { FACTORY_PROOF_POLICY_ID, readPolicyDigest, verificationTraceId } from './proof';
import { getRun } from './runs';
import { isTelemetryEnabled } from './telemetry-config';
import { otelScopesAllow } from './destination-scopes';
import { missionControlReceives, readTelemetryDestinations } from './telemetry-destinations';
import { FACTORY_PRODUCER_NAME, factoryCorrelationResource } from './telemetry-env';
import {
  CONTROL_POST_HEADERS,
  CONTROL_SPOOL_DENIED,
  CONTROL_TRACES_PATH,
  MISSION_CONTROL_RECEIVER,
  countSpooledPayloads,
  deniedForDestination,
  flushTelemetrySpool,
  postOtlpJson,
  spoolOtlpPayload,
  strippedOtlpPayload,
  type SpoolFlushResult,
} from './telemetry-spool';
import { findWorkUnit } from './work-units';

/** Re-exported: the verification trace id is derived from the factory run id (see `proof.ts`). */
export { verificationTraceId };

/**
 * OTel CI/CD spans for verification runs (telemetry profile, "Verification
 * spans"): one run span per `har env verify`, one child span per stage, as
 * OTLP/JSON.
 *
 * Delivery (`deliverVerificationTrace`): fan-out at the producer. The CLI
 * sends the trace to Mission Control and to every `traces` destination itself,
 * one copy each, and queues each copy that was not taken in its own spool
 * entry (`telemetry-spool.ts`). Mission Control stores the run (and syncs it
 * to HQ); it forwards nothing.
 *
 * Spans carry ids, results and timings only: no command lines or log text. The
 * one local path, the Resource `factory.local.checkout_path` that lets Mission
 * Control attribute the run to its repository, is removed from every copy that
 * leaves for a destination and from every spooled copy.
 */

/** `service.name`, the same as `factory.producer.name`. */
const PRODUCER_NAME = FACTORY_PRODUCER_NAME;
/** Instrumentation scope: the npm package that emits the spans. */
const SCOPE_NAME = '@osfactory/har';
const DEFAULT_TIMEOUT_MS = 3_000;

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** Span id of the run span — keyed on the run id, so repeated verifies of one tree never collide. */
export function verificationRunSpanId(id: string): string {
  return sha256Hex(`har-verify-span:${id}`).slice(0, 16);
}

/** Span id of one stage span under the run span. */
export function verificationStageSpanId(id: string, stageId: string): string {
  return sha256Hex(`har-verify-span:${id}:${stageId}`).slice(0, 16);
}

/** Values of `cicd.pipeline.result` / `cicd.pipeline.task.run.result` the profile uses. */
export type CicdResult = 'success' | 'failure' | 'error' | 'timeout' | 'cancellation' | 'skip';

/** `predicate.stages[].status` values (Factory Commits). */
export type FactoryStageStatus = 'passed' | 'failed' | 'error' | 'skipped';

/** The profile's result mapping. */
export function stageStatusToCicdResult(status: FactoryStageStatus): CicdResult {
  switch (status) {
    case 'passed':
      return 'success';
    case 'failed':
      return 'failure';
    case 'error':
      return 'error';
    case 'skipped':
      return 'skip';
  }
}

/** `cicd.pipeline.task.type` only when the stage id obviously says so; undefined otherwise. */
export function cicdTaskType(stageId: string): 'build' | 'test' | undefined {
  if (/(^|[-_.])build$/.test(stageId)) return 'build';
  if (/(^|[-_.])(tests?|e2e)$/.test(stageId)) return 'test';
  return undefined;
}

export interface VerificationTraceInput {
  /** Validation id when one was recorded, else the run id. Keys the trace id. */
  id: string;
  /** Run record id of this verify; keys the span ids. Falls back to `id`. */
  runId?: string;
  /** Statement digest when this run's Factory Commits proof was attested. */
  attestationDigest?: string;
  /** The verify policy, as the proof's `predicate.policy` names it (full verifies only). */
  policyId?: string;
  /** sha256 hex of the policy's `.har/stages.json` bytes (`predicate.policy.digest.sha256`). */
  policyDigest?: string;
  full: boolean;
  /** Parsed verify result; null when verify produced none (→ `error`). */
  verification: VerificationResult | null;
  startedAtMs: number;
  finishedAtMs: number;
  treeHash?: string;
  /** HEAD commit, set only when HEAD's tree is the verified tree. */
  headRevision?: string;
  workUnitId?: string;
  workUnitSource?: string;
  attemptId?: string;
  /** Credential-free repository URL. */
  repositoryUrl?: string;
  branch?: string;
  producerVersion?: string;
  /** Main checkout path; local-only (`factory.local.checkout_path`), for Mission Control attribution. */
  checkoutPath?: string;
}

function runResult(input: VerificationTraceInput): CicdResult {
  if (!input.verification) return 'error';
  return input.verification.status === 'pass' ? 'success' : 'failure';
}

function statusCodeFor(result: CicdResult): number {
  return result === 'failure' || result === 'error' || result === 'timeout'
    ? OTLP_STATUS_CODE.error
    : OTLP_STATUS_CODE.unset;
}

/** One verification run → an OTLP/JSON `ExportTraceServiceRequest`. Pure. */
export function buildVerificationTrace(input: VerificationTraceInput): Record<string, unknown> {
  const traceId = verificationTraceId(input.id);
  const spanKey = input.runId ?? input.id;
  const runSpanId = verificationRunSpanId(spanKey);
  const pipelineName = input.full ? 'har verify --full' : 'har verify';
  const result = runResult(input);
  const runEnd = Math.max(input.startedAtMs, input.finishedAtMs);

  const runSpan: OtlpSpanInput = {
    traceId,
    spanId: runSpanId,
    name: pipelineName,
    kind: OTLP_SPAN_KIND.server,
    startTimeMs: input.startedAtMs,
    endTimeMs: runEnd,
    statusCode: statusCodeFor(result),
    attributes: {
      'cicd.pipeline.name': pipelineName,
      'cicd.pipeline.run.id': input.id,
      'cicd.pipeline.result': result,
      'factory.run.id': input.id,
      'factory.git.tree': input.treeHash,
      'factory.verdict':
        input.full && input.verification ? (input.verification.status === 'pass' ? 'pass' : 'fail') : undefined,
      'vcs.ref.head.revision': input.headRevision,
      'factory.attestation.digest': input.attestationDigest,
      'factory.policy.id': input.policyId,
      'factory.policy.digest': input.policyDigest,
    },
  };

  // Stages run sequentially; the verify result has durations, not start times.
  let cursor = input.startedAtMs;
  const stageSpans: OtlpSpanInput[] = (input.verification?.stages ?? []).map((stage) => {
    const start = Math.min(cursor, runEnd);
    const end = Math.min(start + Math.max(0, stage.ms ?? 0), runEnd);
    cursor = end;
    const stageResult = stageStatusToCicdResult(stage.pass ? 'passed' : 'failed');
    return {
      traceId,
      spanId: verificationStageSpanId(spanKey, stage.name),
      parentSpanId: runSpanId,
      name: stage.name,
      kind: OTLP_SPAN_KIND.internal,
      startTimeMs: start,
      endTimeMs: end,
      statusCode: statusCodeFor(stageResult),
      attributes: {
        'cicd.pipeline.task.name': stage.name,
        'cicd.pipeline.task.run.id': `${input.id}:${stage.name}`,
        'cicd.pipeline.task.run.result': stageResult,
        'cicd.pipeline.task.type': cicdTaskType(stage.name),
        'factory.stage.added_by': 'policy',
      },
    };
  });

  return encodeOtlpTraces({
    resource: {
      'service.name': PRODUCER_NAME,
      // Same helper as agent sessions' OTEL_RESOURCE_ATTRIBUTES: identical join keys.
      ...factoryCorrelationResource({
        workUnitId: input.workUnitId,
        workUnitSource: input.workUnitSource,
        attemptId: input.attemptId,
        repositoryUrl: input.repositoryUrl,
        branch: input.branch,
        producerVersion: input.producerVersion,
      }),
      ...(input.checkoutPath ? { [LOCAL_CHECKOUT_PATH_ATTR]: input.checkoutPath } : {}),
    },
    scope: { name: SCOPE_NAME, version: input.producerVersion },
    spans: [runSpan, ...stageSpans],
  });
}

function commitTree(checkoutDir: string, commit: string): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', `${commit}^{tree}`], {
      cwd: checkoutDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function safely<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function optionalPolicyDigest(harnessRoot: string): { policyDigest?: string } {
  const digest = safely(() => readPolicyDigest(harnessRoot));
  return digest ? { policyDigest: digest } : {};
}

/** What `runVerification` knows once the verify result is final. */
export interface VerificationTraceContext {
  repoPath: string;
  harnessRoot?: string;
  checkoutDir?: string;
  full: boolean;
  verification: VerificationResult | null;
  runId?: string;
  validation?: { validationId: string; treeHash: string; headSha?: string; branch?: string };
  /** Digest of the Factory Commits statement attested for this run, if any. */
  attestationDigest?: string;
  workUnitId?: string;
  attemptId?: string;
  branch?: string;
}

/**
 * Gather the trace input: timestamps from the run record, work unit source,
 * repository URL, producer version, and the HEAD commit only when its tree is
 * the verified tree. Every lookup is best-effort.
 */
export function collectVerificationTraceInput(context: VerificationTraceContext): VerificationTraceInput {
  const run = context.runId ? safely(() => getRun(context.repoPath, context.runId!)) : undefined;
  const finishedAtMs = run?.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  const startedAtMs = run?.startedAt
    ? Date.parse(run.startedAt)
    : finishedAtMs - (context.verification?.total_ms ?? 0);
  const validation = context.validation;
  const headRevision =
    validation?.headSha && context.checkoutDir && commitTree(context.checkoutDir, validation.headSha) === validation.treeHash
      ? validation.headSha
      : undefined;
  const workUnitSource =
    context.workUnitId && context.harnessRoot
      ? safely(() => findWorkUnit(context.harnessRoot!, context.workUnitId!)?.source)
      : undefined;
  return {
    id: validation?.validationId ?? context.runId ?? crypto.randomUUID(),
    ...(context.runId ? { runId: context.runId } : {}),
    ...(context.attestationDigest ? { attestationDigest: context.attestationDigest } : {}),
    // The same policy the proof's predicate names: only a full verify runs it.
    ...(context.full ? { policyId: FACTORY_PROOF_POLICY_ID } : {}),
    ...(context.full ? optionalPolicyDigest(context.harnessRoot ?? context.repoPath) : {}),
    full: context.full,
    verification: context.verification,
    startedAtMs,
    finishedAtMs,
    treeHash: validation?.treeHash,
    headRevision,
    workUnitId: context.workUnitId,
    workUnitSource,
    attemptId: context.attemptId,
    repositoryUrl: sanitizeGitRemoteUrl(safely(() => readGitRemote(context.checkoutDir ?? context.repoPath))),
    branch: validation?.branch ?? context.branch,
    producerVersion: safely(getHarPackageVersion),
    checkoutPath: context.harnessRoot ?? context.repoPath,
  };
}

export interface VerificationSpanExportResult {
  /** Destinations the trace was sent to. */
  destinations: number;
  /** Names of destinations that failed (HTTP error, timeout, network). */
  failed: string[];
}

export interface ExportVerificationTraceOptions {
  fetchImpl?: typeof fetch;
  /** Per destination. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** One POST attempt: `ok`, or a short error that holds no URL or header value (`HTTP 503`, `ECONNREFUSED`, `timeout`). */
export interface PostOutcome {
  ok: boolean;
  error?: string;
}

async function postTrace(
  destination: TelemetryDestination,
  body: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<PostOutcome> {
  return postOtlpJson(
    fetchImpl,
    otlpSignalUrl(destination.endpoint, 'traces'),
    { ...destination.headers },
    body,
    timeoutMs,
  );
}

/**
 * Whether a verification trace will be exported: telemetry is not off, and
 * Mission Control is enabled (it receives the trace now, or later from the
 * spool) or at least one enabled destination subscribes to `traces`. Cheap,
 * never throws. A proof only names a trace when this is true.
 */
export function willExportVerificationSpans(env?: NodeJS.ProcessEnv): boolean {
  try {
    if (!isTelemetryEnabled()) return false;
    if (verificationTraceControlUrl(env ?? process.env) !== undefined) return true;
    return destinationsForSignal(readTelemetryDestinations(env), 'traces').length > 0;
  } catch {
    return false;
  }
}

function enabledTraceDestinations(env?: NodeJS.ProcessEnv): TelemetryDestination[] {
  try {
    return destinationsForSignal(readTelemetryDestinations(env), 'traces');
  } catch {
    return [];
  }
}

/**
 * Send one built trace to each destination, stripped per destination, in
 * parallel. Failed copies are spooled when `spool` is set.
 */
async function sendToDestinations(
  payload: Record<string, unknown>,
  destinations: TelemetryDestination[],
  options: ExportVerificationTraceOptions & { spool: boolean },
): Promise<{ result: VerificationSpanExportResult; spooled: number }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const copies = destinations.map((destination) => strippedOtlpPayload(payload, deniedForDestination(destination)));
  const outcomes = await Promise.all(
    destinations.map((destination, index) =>
      postTrace(destination, JSON.stringify(copies[index]), fetchImpl, timeoutMs),
    ),
  );
  let spooled = 0;
  const failed: string[] = [];
  destinations.forEach((destination, index) => {
    if (outcomes[index].ok) return;
    failed.push(destination.name);
    if (
      options.spool &&
      spoolOtlpPayload({ kind: 'destination', name: destination.name }, copies[index], deniedForDestination(destination), {
        env: options.env,
        lastError: outcomes[index].error,
      })
    ) {
      spooled += 1;
    }
  });
  return { result: { destinations: destinations.length, failed }, spooled };
}

/**
 * Send one verification trace to every enabled `traces` destination, in
 * parallel, each bounded by a short timeout; a failed copy is queued in the
 * spool for a later flush. Mission Control is not involved. Fail-open: never
 * throws. Returns undefined when nothing was attempted (telemetry off, no
 * destinations, unreadable config); `resolve` is only called after that check.
 */
export async function exportVerificationTrace(
  resolve: () => VerificationTraceInput,
  options: ExportVerificationTraceOptions = {},
): Promise<VerificationSpanExportResult | undefined> {
  try {
    if (!isTelemetryEnabled()) return undefined;
    const all = destinationsForSignal(readTelemetryDestinations(options.env), 'traces');
    if (all.length === 0) return undefined;
    const input = resolve();
    // A scoped destination (every hosted receiver) gets the trace only for a repository it lists.
    const destinations = all.filter((destination) => otelScopesAllow(destination.scopes, input.repositoryUrl, 'traces'));
    if (destinations.length === 0) return undefined;
    const sent = await sendToDestinations(buildVerificationTrace(input), destinations, {
      ...options,
      spool: true,
    });
    return sent.result;
  } catch {
    return undefined;
  }
}

/** How a verification trace left the CLI: one copy per receiver, sent now or queued. */
export interface VerificationTraceDelivery {
  /** Fan-out at the producer: the CLI sends to Mission Control and to each destination itself. */
  via: 'fanout';
  /** Receivers that accepted their copy now (`mission-control` and destination names). */
  delivered: string[];
  /** Copies queued in the CLI spool for a later attempt (one per receiver that did not take it). */
  spooled: number;
}

export interface DeliverVerificationTraceOptions extends ExportVerificationTraceOptions {
  /**
   * Mission Control base URL, or false to leave it out. Default:
   * `HAR_CONTROL_API_URL` / the local default, unless `HAR_CONTROL_DISABLED=true`
   * (or under a test runner without `HAR_TEST_VERIFICATION_TRACE_CONTROL=on`).
   */
  controlApiUrl?: string | false;
  /** Health check override (tests). */
  controlReachable?: (apiUrl: string) => Promise<boolean>;
}

export interface VerificationTraceDeliveryResult {
  /** Set when at least one destination was sent to. */
  spanExport?: VerificationSpanExportResult;
  delivery?: VerificationTraceDelivery;
}

/** Test-runner opt-in for sending to Mission Control (`on`). */
export const VERIFICATION_TRACE_CONTROL_TEST_ENV = 'HAR_TEST_VERIFICATION_TRACE_CONTROL';

/** Mission Control base URL to send to, or undefined. */
export function verificationTraceControlUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isControlEnabled()) return undefined;
  // Unit tests never reach a developer's running Mission Control by accident
  // (a slot's env file sets HAR_CONTROL_API_URL to the live one): only a test
  // that opts in sends to it.
  // The guard checks the real process too: a caller-supplied env without
  // NODE_ENV must not bypass it while a test runner is running.
  const underTest = env.NODE_ENV === 'test' || process.env.NODE_ENV === 'test';
  if (underTest && env[VERIFICATION_TRACE_CONTROL_TEST_ENV] !== 'on') return undefined;
  // Mission Control is one entry of the destination list: removed, disabled or not subscribed to traces → not sent.
  if (!missionControlReceives('traces', env)) return undefined;
  return getControlApiUrl().replace(/\/+$/, '');
}

const CONTROL_HEALTH_TIMEOUT_MS = 1_000;

/**
 * Deliver one verification trace to every receiver exactly once: fan-out at
 * the producer, Mission Control being one receiver among the destinations.
 * Fail-open.
 *
 * Each receiver gets one live attempt, in parallel: Mission Control (when it
 * is enabled; skipped without a request when its health check fails) and every
 * enabled `traces` destination, stripped per destination. A receiver that did
 * not take its copy gets it queued in the CLI spool, keyed to that receiver
 * alone, and the spool deletes an entry once it is accepted, so no receiver is
 * ever sent a copy meant for another. Mission Control forwards nothing.
 */
export async function deliverVerificationTrace(
  resolve: () => VerificationTraceInput,
  options: DeliverVerificationTraceOptions = {},
): Promise<VerificationTraceDeliveryResult> {
  try {
    if (!isTelemetryEnabled()) return {};
    const candidates = enabledTraceDestinations(options.env);
    const controlUrl =
      options.controlApiUrl === false
        ? undefined
        : (options.controlApiUrl?.replace(/\/+$/, '') ?? verificationTraceControlUrl(options.env ?? process.env));
    if (candidates.length === 0 && !controlUrl) return {};

    const input = resolve();
    // A scoped destination (every hosted receiver) gets the trace only for a repository it lists.
    const destinations = candidates.filter((destination) =>
      otelScopesAllow(destination.scopes, input.repositoryUrl, 'traces'),
    );
    if (destinations.length === 0 && !controlUrl) return {};
    const payload = buildVerificationTrace(input);
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const toControl = async (): Promise<PostOutcome | undefined> => {
      if (!controlUrl) return undefined;
      const reachable = options.controlReachable
        ? await options.controlReachable(controlUrl)
        : await isControlApiReachable(controlUrl, CONTROL_HEALTH_TIMEOUT_MS);
      if (!reachable) return { ok: false, error: 'not reachable' };
      return postOtlpJson(fetchImpl, `${controlUrl}${CONTROL_TRACES_PATH}`, CONTROL_POST_HEADERS, JSON.stringify(payload), timeoutMs);
    };
    const [control, sent] = await Promise.all([
      toControl(),
      destinations.length > 0 ? sendToDestinations(payload, destinations, { ...options, spool: true }) : undefined,
    ]);

    let spooled = sent?.spooled ?? 0;
    const delivered: string[] = [];
    if (control?.ok) delivered.push(MISSION_CONTROL_RECEIVER);
    else if (
      control &&
      spoolOtlpPayload({ kind: 'control' }, payload, CONTROL_SPOOL_DENIED, { env: options.env, lastError: control.error })
    ) {
      spooled += 1;
    }
    if (sent) {
      delivered.push(...destinations.map((destination) => destination.name).filter((name) => !sent.result.failed.includes(name)));
    }
    return {
      ...(sent ? { spanExport: sent.result } : {}),
      delivery: { via: 'fanout', delivered, spooled },
    };
  } catch {
    return {};
  }
}

export interface FlushVerificationTraceSpoolOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  budgetMs?: number;
  maxSends?: number;
  controlApiUrl?: string | false;
  controlReachable?: (apiUrl: string) => Promise<boolean>;
}

/** Budget of the opportunistic flush at the start of `har env verify` / `launch`. */
export const SPOOL_FLUSH_AT_START = { budgetMs: 2_000, maxSends: 16 } as const;

/**
 * Retry what the CLI spooled: destination copies, and Mission Control copies
 * when it is running. Cheap when the spool is empty (one directory read, no
 * network). Fail-open; telemetry off → nothing.
 */
export async function flushVerificationTraceSpool(
  options: FlushVerificationTraceSpoolOptions = {},
): Promise<SpoolFlushResult | undefined> {
  try {
    if (!isTelemetryEnabled()) return undefined;
    if (countSpooledPayloads(options.env) === 0) return { sent: 0, retried: 0, dropped: 0, pending: 0 };
    const controlApiUrl =
      options.controlApiUrl === false
        ? undefined
        : (options.controlApiUrl ?? verificationTraceControlUrl(options.env ?? process.env));
    return await flushTelemetrySpool({
      env: options.env,
      fetchImpl: options.fetchImpl,
      budgetMs: options.budgetMs ?? SPOOL_FLUSH_AT_START.budgetMs,
      maxSends: options.maxSends ?? SPOOL_FLUSH_AT_START.maxSends,
      controlApiUrl,
      controlReachable: controlApiUrl
        ? () =>
            options.controlReachable
              ? options.controlReachable(controlApiUrl)
              : isControlApiReachable(controlApiUrl, CONTROL_HEALTH_TIMEOUT_MS)
        : undefined,
    });
  } catch {
    return undefined;
  }
}
