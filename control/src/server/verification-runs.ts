import { LOCAL_CHECKOUT_PATH_ATTR } from '@har/schemas';
import { prisma } from '@/lib/db';
import { normalizeOtelPath, pickBestRepoPathMatch } from '@/server/otel-workspace';
import type { AttrMap, OtelIngestResult, ParsedSpan } from '@/server/otel-ingest';
import { repositoryKeyFor, repositoryUrlKey } from '@/server/repository-key';

export { repositoryUrlKey };

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

type RepoRow = { id: string; path: string; gitRemote: string | null };

/** The repository a verification trace belongs to, or a reason it has none. */
export async function resolveVerificationRepository(
  resource: AttrMap,
): Promise<{ repositoryId: string; repositoryKey: string } | { reason: string }> {
  const repos: RepoRow[] = await prisma.repository.findMany({ select: { id: true, path: true, gitRemote: true } });
  const checkout = text(resource, LOCAL_CHECKOUT_PATH_ATTR);
  if (checkout) {
    const best = pickBestRepoPathMatch(
      checkout,
      repos.map((repo) => repo.path),
    );
    const match = best ? repos.find((repo) => normalizeOtelPath(repo.path) === best) : undefined;
    if (match) return { repositoryId: match.id, repositoryKey: repositoryKeyFor(match) };
  }
  const key = repositoryUrlKey(text(resource, REPOSITORY_URL_ATTR));
  if (key) {
    const matches = repos.filter((repo) => repositoryUrlKey(repo.gitRemote) === key);
    if (matches.length === 1) return { repositoryId: matches[0].id, repositoryKey: key };
    if (matches.length > 1) {
      // Several clones of one remote: the one whose slot holds the run's attempt or branch.
      const attemptId = text(resource, 'factory.attempt.id');
      if (attemptId) {
        const attempt = await prisma.attempt.findFirst({
          where: { attemptId, repositoryId: { in: matches.map((repo) => repo.id) } },
          select: { repositoryId: true },
        });
        if (attempt?.repositoryId) return { repositoryId: attempt.repositoryId, repositoryKey: key };
      }
      return { reason: `verification run: ${matches.length} repositories share ${key}` };
    }
  }
  return { reason: `verification run: unknown repository for ${checkout || key || '(no checkout path or repository url)'}` };
}

function cicdResult(span: ParsedSpan, key: string): string {
  return text(span.attributes, key) ?? 'error';
}

/** A cicd task result (`cicd.pipeline.task.run.result`) as a Factory Commits stage status. */
export function stageStatusOfCicdResult(result: string): 'passed' | 'failed' | 'error' | 'skipped' {
  if (result === 'success') return 'passed';
  if (result === 'failure') return 'failed';
  if (result === 'skip') return 'skipped';
  return 'error';
}

function durationMs(span: ParsedSpan): number | null {
  return span.endTime ? Math.max(0, span.endTime.getTime() - span.startTime.getTime()) : null;
}

/**
 * Store the run spans as factory runs, then the stage spans as their stage
 * results. A factory run is one row per validation id (ADR 0005 section 3):
 * every verify of a tree shares it, and the latest verify span wins. Fields a
 * v2 record already set are only filled, never overwritten, by a span.
 */
export async function ingestVerificationSpans(spans: ParsedSpan[]): Promise<OtelIngestResult> {
  const result: OtelIngestResult = { accepted: 0, dropped: 0, reasons: [] };
  const runs = spans.filter(isVerificationRunSpan);
  const stages = spans.filter(isVerificationStageSpan);
  const runIds = new Map<string, string>(); // `${traceId}:${spanId}` → factory run id

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
    const factoryRunId = text(attrs, RUN_ID_ATTR) as string;
    const existing = await prisma.factoryRun.findUnique({ where: { factoryRunId } });
    const latest = !existing?.finishedAt || !span.endTime || span.endTime >= existing.finishedAt;
    const fromSpan = {
      status: cicdResult(span, 'cicd.pipeline.result'),
      verdict: text(attrs, 'factory.verdict') ?? null,
      tree: text(attrs, 'factory.git.tree') ?? null,
      headSha: text(attrs, 'vcs.ref.head.revision') ?? null,
      attestationDigest: text(attrs, 'factory.attestation.digest') ?? null,
      policyId: text(attrs, 'factory.policy.id') ?? null,
      policyDigest: text(attrs, 'factory.policy.digest') ?? null,
      workUnitId: text(span.resource, 'factory.work_unit.id') ?? text(attrs, 'factory.work_unit.id') ?? null,
      attemptId: text(span.resource, 'factory.attempt.id') ?? text(attrs, 'factory.attempt.id') ?? null,
      branch: text(span.resource, 'vcs.ref.head.name') ?? null,
    };
    const spanFields = {
      traceId: span.traceId,
      pipelineName: text(attrs, 'cicd.pipeline.name') ?? span.name,
      producerVersion: text(span.resource, 'factory.producer.version') ?? null,
    };
    if (!existing) {
      await prisma.factoryRun.create({
        data: {
          factoryRunId,
          repositoryId: repository.repositoryId,
          repositoryKey: repository.repositoryKey,
          ...fromSpan,
          tree: fromSpan.tree ?? '',
          full: fromSpan.verdict != null,
          ...spanFields,
          spanId: span.spanId,
          startedAt: span.startTime,
          finishedAt: span.endTime,
        },
      });
    } else {
      // The latest verify span replaces what an earlier span set; it only fills what a v2 record left empty.
      const recordOwned = existing.policyRequired != null;
      const fill: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(fromSpan)) {
        const stored = (existing as Record<string, unknown>)[key];
        if (value != null && (stored == null || stored === '' || (latest && !recordOwned))) fill[key] = value;
      }
      await prisma.factoryRun.update({
        where: { id: existing.id },
        data: {
          ...fill,
          ...(latest || existing.spanId == null
            ? { ...spanFields, spanId: span.spanId, finishedAt: recordOwned ? existing.finishedAt : span.endTime }
            : {}),
          traceId: existing.traceId ?? span.traceId,
          repositoryId: existing.repositoryId ?? repository.repositoryId,
          startedAt: span.startTime < existing.startedAt ? span.startTime : existing.startedAt,
          ...(fromSpan.verdict != null ? { full: true } : {}),
        },
      });
    }
    runIds.set(`${span.traceId}:${span.spanId}`, factoryRunId);
    result.accepted += 1;
  }

  for (const span of stages) {
    if (!span.traceId || !span.spanId || !span.parentSpanId) {
      result.dropped += 1;
      result.reasons.push('verification stage: missing trace/span/parent id');
      continue;
    }
    let factoryRunId = runIds.get(`${span.traceId}:${span.parentSpanId}`);
    if (!factoryRunId) {
      const parent = await prisma.factoryRun.findFirst({
        where: { traceId: span.traceId, spanId: span.parentSpanId },
        select: { factoryRunId: true },
      });
      factoryRunId = parent?.factoryRunId;
    }
    if (!factoryRunId) {
      result.dropped += 1;
      result.reasons.push('verification stage: its run span was not stored');
      continue;
    }
    const stageId = text(span.attributes, 'cicd.pipeline.task.name') ?? span.name;
    const described = {
      status: stageStatusOfCicdResult(cicdResult(span, 'cicd.pipeline.task.run.result')),
      kind: text(span.attributes, 'cicd.pipeline.task.type') ?? null,
      addedBy: text(span.attributes, 'factory.stage.added_by') ?? null,
      durationMs: durationMs(span),
    };
    const timing = { traceId: span.traceId, spanId: span.spanId, startTime: span.startTime, endTime: span.endTime };
    const where = { factoryRunId_stageId: { factoryRunId, stageId } };
    const stored = await prisma.stageResult.findUnique({ where });
    if (!stored) {
      await prisma.stageResult.create({ data: { factoryRunId, stageId, ...described, ...timing } });
    } else {
      // A StageResult record (ADR 0005; it always stores `artifacts`) describes the stage:
      // its span only fills what the record left empty. Without a record, the latest span wins.
      const recordOwned = stored.artifacts != null;
      const fill: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(described)) {
        if (!recordOwned || (value != null && (stored as Record<string, unknown>)[key] == null)) fill[key] = value;
      }
      await prisma.stageResult.update({ where: { id: stored.id }, data: { ...fill, ...timing } });
    }
    const run = await prisma.factoryRun.findUnique({ where: { factoryRunId }, select: { id: true, stageIds: true } });
    const ids = Array.isArray(run?.stageIds) ? (run.stageIds as string[]) : [];
    if (run && !ids.includes(stageId)) {
      await prisma.factoryRun.update({ where: { id: run.id }, data: { stageIds: [...ids, stageId] } });
    }
    result.accepted += 1;
  }
  return result;
}
