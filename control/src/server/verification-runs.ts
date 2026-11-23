import type { VerificationRun, VerificationStage } from '@prisma/client';
import { LOCAL_CHECKOUT_PATH_ATTR } from '@har/schemas';
import { prisma } from '@/lib/db';
import { gitRemoteBrowseUrl } from '@/lib/git-remote-url';
import { clampPageLimit, createdAtKeyset } from '@/server/pagination';
import { normalizeOtelPath, pickBestRepoPathMatch } from '@/server/otel-workspace';
import type { AttrMap, OtelIngestResult, ParsedSpan } from '@/server/otel-ingest';

/**
 * Verification runs received over OTLP. `har env verify` sends one trace per
 * verify (telemetry profile, "Verification spans"): a run span carrying
 * `cicd.pipeline.run.id` and one child span per stage carrying
 * `cicd.pipeline.task.run.id`, all under the instrumentation scope
 * `@osfactory/har`.
 *
 * A run is attributed to a registered repository through its Resource:
 * `factory.local.checkout_path` (present when the CLI posts to Mission Control
 * live), else `vcs.repository.url.full` matched against the repositories' git
 * remotes (a copy the CLI spooled while Mission Control was down carries no
 * local path). Runs are upserted by (trace id, span id), so a re-delivered
 * trace is stored once.
 */

export const VERIFICATION_SCOPE_NAME = '@osfactory/har';
const RUN_ID_ATTR = 'cicd.pipeline.run.id';
const TASK_RUN_ID_ATTR = 'cicd.pipeline.task.run.id';
const REPOSITORY_URL_ATTR = 'vcs.repository.url.full';

function text(map: AttrMap, key: string): string | undefined {
  const value = map[key];
  if (value === undefined || value === null) return undefined;
  const out = String(value).trim();
  return out ? out : undefined;
}

export function isVerificationRunSpan(span: ParsedSpan): boolean {
  return span.scopeName === VERIFICATION_SCOPE_NAME && text(span.attributes, RUN_ID_ATTR) !== undefined;
}

export function isVerificationStageSpan(span: ParsedSpan): boolean {
  return (
    span.scopeName === VERIFICATION_SCOPE_NAME &&
    text(span.attributes, RUN_ID_ATTR) === undefined &&
    text(span.attributes, TASK_RUN_ID_ATTR) !== undefined
  );
}

export function isVerificationSpan(span: ParsedSpan): boolean {
  return isVerificationRunSpan(span) || isVerificationStageSpan(span);
}

/** Host and path of a remote, lowercased, without scheme, credentials or `.git`. */
export function repositoryUrlKey(remote: string | null | undefined): string | null {
  if (!remote) return null;
  const browse = gitRemoteBrowseUrl(remote);
  if (!browse) return null;
  try {
    const url = new URL(browse);
    return `${url.hostname}${url.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return null;
  }
}

type RepoRow = { id: string; path: string; gitRemote: string | null };

/** The repository a verification trace belongs to, or a reason it has none. */
export async function resolveVerificationRepository(
  resource: AttrMap,
): Promise<{ repositoryId: string } | { reason: string }> {
  const repos: RepoRow[] = await prisma.repository.findMany({ select: { id: true, path: true, gitRemote: true } });
  const checkout = text(resource, LOCAL_CHECKOUT_PATH_ATTR);
  if (checkout) {
    const best = pickBestRepoPathMatch(
      checkout,
      repos.map((repo) => repo.path),
    );
    const match = best ? repos.find((repo) => normalizeOtelPath(repo.path) === best) : undefined;
    if (match) return { repositoryId: match.id };
  }
  const key = repositoryUrlKey(text(resource, REPOSITORY_URL_ATTR));
  if (key) {
    const matches = repos.filter((repo) => repositoryUrlKey(repo.gitRemote) === key);
    if (matches.length === 1) return { repositoryId: matches[0].id };
    if (matches.length > 1) {
      // Several clones of one remote: the one whose slot holds the run's attempt or branch.
      const attemptId = text(resource, 'factory.attempt.id');
      if (attemptId) {
        const attempt = await prisma.workAttempt.findFirst({
          where: { attemptId, repositoryId: { in: matches.map((repo) => repo.id) } },
          select: { repositoryId: true },
        });
        if (attempt) return { repositoryId: attempt.repositoryId };
      }
      return { reason: `verification run: ${matches.length} repositories share ${key}` };
    }
  }
  return { reason: `verification run: unknown repository for ${checkout || key || '(no checkout path or repository url)'}` };
}

function cicdResult(span: ParsedSpan, key: string): string {
  return text(span.attributes, key) ?? 'error';
}

/** Store the run spans, then the stage spans under their run. */
export async function ingestVerificationSpans(spans: ParsedSpan[]): Promise<OtelIngestResult> {
  const result: OtelIngestResult = { accepted: 0, dropped: 0, reasons: [] };
  const runs = spans.filter(isVerificationRunSpan);
  const stages = spans.filter(isVerificationStageSpan);
  const runIds = new Map<string, string>(); // `${traceId}:${spanId}` → VerificationRun.id

  for (const span of runs) {
    if (!span.traceId || !span.spanId) {
      result.dropped += 1;
      result.reasons.push('verification run: missing trace/span id');
      continue;
    }
    const repository = await resolveVerificationRepository(span.resource);
    if ('reason' in repository) {
      result.dropped += 1;
      result.reasons.push(repository.reason);
      continue;
    }
    const attrs = span.attributes;
    const fields = {
      repositoryId: repository.repositoryId,
      runId: text(attrs, RUN_ID_ATTR) as string,
      pipelineName: text(attrs, 'cicd.pipeline.name') ?? span.name,
      result: cicdResult(span, 'cicd.pipeline.result'),
      verdict: text(attrs, 'factory.verdict') ?? null,
      treeHash: text(attrs, 'factory.git.tree') ?? null,
      headRevision: text(attrs, 'vcs.ref.head.revision') ?? null,
      attestationDigest: text(attrs, 'factory.attestation.digest') ?? null,
      workUnitId: text(span.resource, 'factory.work_unit.id') ?? text(attrs, 'factory.work_unit.id') ?? null,
      attemptId: text(span.resource, 'factory.attempt.id') ?? text(attrs, 'factory.attempt.id') ?? null,
      branch: text(span.resource, 'vcs.ref.head.name') ?? null,
      producerVersion: text(span.resource, 'factory.producer.version') ?? null,
      startTime: span.startTime,
      endTime: span.endTime,
    };
    const stored = await prisma.verificationRun.upsert({
      where: { traceId_spanId: { traceId: span.traceId, spanId: span.spanId } },
      create: { ...fields, traceId: span.traceId, spanId: span.spanId },
      update: fields,
      select: { id: true },
    });
    runIds.set(`${span.traceId}:${span.spanId}`, stored.id);
    result.accepted += 1;
  }

  for (const span of stages) {
    if (!span.traceId || !span.spanId || !span.parentSpanId) {
      result.dropped += 1;
      result.reasons.push('verification stage: missing trace/span/parent id');
      continue;
    }
    let verificationRunId = runIds.get(`${span.traceId}:${span.parentSpanId}`);
    if (!verificationRunId) {
      const parent = await prisma.verificationRun.findUnique({
        where: { traceId_spanId: { traceId: span.traceId, spanId: span.parentSpanId } },
        select: { id: true },
      });
      verificationRunId = parent?.id;
    }
    if (!verificationRunId) {
      result.dropped += 1;
      result.reasons.push('verification stage: its run span was not stored');
      continue;
    }
    const fields = {
      verificationRunId,
      name: text(span.attributes, 'cicd.pipeline.task.name') ?? span.name,
      result: cicdResult(span, 'cicd.pipeline.task.run.result'),
      taskType: text(span.attributes, 'cicd.pipeline.task.type') ?? null,
      startTime: span.startTime,
      endTime: span.endTime,
    };
    await prisma.verificationStage.upsert({
      where: { traceId_spanId: { traceId: span.traceId, spanId: span.spanId } },
      create: { ...fields, traceId: span.traceId, spanId: span.spanId },
      update: fields,
    });
    result.accepted += 1;
  }
  return result;
}

const REPO_RUNS_LIMIT = 500;
const REPO_RUNS_MAX_LIMIT = 2_000;

export type VerificationRunWithStages = VerificationRun & { stages: VerificationStage[] };

/** One repository's verification runs with their stages, oldest first, keyset-paged on (createdAt, id). */
export async function listVerificationRunsForRepo(
  repositoryId: string,
  options: { since?: string | null; sinceId?: string | null; limit?: number } = {},
): Promise<VerificationRunWithStages[]> {
  return prisma.verificationRun.findMany({
    where: { repositoryId, ...createdAtKeyset(options) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: clampPageLimit(options.limit, REPO_RUNS_LIMIT, REPO_RUNS_MAX_LIMIT),
    include: { stages: { orderBy: [{ startTime: 'asc' }, { name: 'asc' }] } },
  });
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

/** The JSON row of `GET /api/repos/:id/verification-runs` (what the HQ sync reads). */
export function verificationRunJson(run: VerificationRunWithStages) {
  return {
    id: run.id,
    runId: run.runId,
    traceId: run.traceId,
    spanId: run.spanId,
    pipelineName: run.pipelineName,
    result: run.result,
    verdict: run.verdict,
    treeHash: run.treeHash,
    headRevision: run.headRevision,
    attestationDigest: run.attestationDigest,
    workUnitId: run.workUnitId,
    attemptId: run.attemptId,
    branch: run.branch,
    producerVersion: run.producerVersion,
    startTime: run.startTime.toISOString(),
    endTime: iso(run.endTime),
    createdAt: run.createdAt.toISOString(),
    stages: run.stages.map((stage) => ({
      name: stage.name,
      spanId: stage.spanId,
      result: stage.result,
      taskType: stage.taskType,
      startTime: stage.startTime.toISOString(),
      endTime: iso(stage.endTime),
    })),
  };
}
