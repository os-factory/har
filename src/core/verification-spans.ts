import { execFileSync } from 'child_process';
import * as crypto from 'crypto';
import {
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
import { readGitRemote, sanitizeGitRemoteUrl } from './git-remote';
import { getHarPackageVersion } from './package-version';
import { getRun } from './runs';
import { isTelemetryEnabled } from './telemetry-config';
import { readTelemetryDestinations } from './telemetry-destinations';
import { FACTORY_PRODUCER_NAME, factoryCorrelationResource } from './telemetry-env';
import { findWorkUnit } from './work-units';

/**
 * OTel CI/CD spans for verification runs (telemetry profile, "Verification
 * spans"): one run span per `har env verify`, one child span per stage, sent
 * as OTLP/JSON straight to the configured `traces` destinations.
 *
 * No destination → nothing is built and nothing is sent. Spans carry ids,
 * results and timings only: no command lines, log text or local paths.
 */

/** `service.name`, the same as `factory.producer.name`. */
const PRODUCER_NAME = FACTORY_PRODUCER_NAME;
const SCOPE_NAME = 'har.verification';
const DEFAULT_TIMEOUT_MS = 3_000;

function sha256Hex(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

/**
 * Trace id of a verification — derived from the validation id (or the run id
 * when no validation was recorded) so a proof or another HAR surface can
 * reference the trace without coordination. Every verify of the same tree
 * lands in the same trace.
 */
export function verificationTraceId(id: string): string {
  return sha256Hex(`har-verify:${id}`).slice(0, 32);
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

async function postTrace(
  destination: TelemetryDestination,
  body: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const response = await fetchImpl(otlpSignalUrl(destination.endpoint, 'traces'), {
      method: 'POST',
      headers: { ...destination.headers, 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain so the socket is released; the body is never surfaced.
    await response.text().catch(() => '');
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Whether a verification trace will be exported: telemetry is not off and at
 * least one enabled destination subscribes to `traces`. Cheap (reads one small
 * config file), never throws. A proof only names a trace when this is true.
 */
export function willExportVerificationSpans(env?: NodeJS.ProcessEnv): boolean {
  try {
    if (!isTelemetryEnabled()) return false;
    return destinationsForSignal(readTelemetryDestinations(env), 'traces').length > 0;
  } catch {
    return false;
  }
}

/**
 * Send one verification trace to every enabled `traces` destination, in
 * parallel, each bounded by a short timeout. Fail-open: never throws.
 * Returns undefined when nothing was attempted (telemetry off, no
 * destinations, unreadable config); `resolve` is only called after that check.
 */
export async function exportVerificationTrace(
  resolve: () => VerificationTraceInput,
  options: ExportVerificationTraceOptions = {},
): Promise<VerificationSpanExportResult | undefined> {
  try {
    if (!isTelemetryEnabled()) return undefined;
    const destinations = destinationsForSignal(readTelemetryDestinations(options.env), 'traces');
    if (destinations.length === 0) return undefined;

    const body = JSON.stringify(buildVerificationTrace(resolve()));
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const outcomes = await Promise.all(
      destinations.map((destination) => postTrace(destination, body, fetchImpl, timeoutMs)),
    );
    return {
      destinations: destinations.length,
      failed: destinations.filter((_, index) => !outcomes[index]).map((destination) => destination.name),
    };
  } catch {
    return undefined;
  }
}
