import type { Attempt, FactoryRun, Prisma, StageResult, UsageObservation, WorkUnit } from '@prisma/client';
import { GENAI_PRICES_LABEL } from '@har/schemas';
import { prisma } from '@/lib/db';
import { stagesOf } from '@/server/factory-runs';
import { recordRepositoryKey } from '@/server/repository-key';

/**
 * The work unit view (ADR 0005 section 3): a fixed set of joins on the v2
 * records, the same in every receiver.
 *
 *   WorkUnit ─▶ Attempt ─┬─▶ FactoryRun ─┬─▶ StageResult ─▶ EvidenceBlob
 *                        │               ├─▶ Attestation ─▶ CommitBinding
 *                        └─▶ trajectory and usage (factory.attempt.id, up to FactoryRun.finishedAt)
 *
 * Read APIs: `GET /api/v2/work-units/{workUnitId}`, `GET /api/v2/factory-runs/{id}`,
 * `GET /api/v2/proofs/{digest}`.
 */

const TRAJECTORY_EVENTS = 200;

/** Where a receiver serves stored evidence bytes, relative to its ingest base URL. */
export function evidenceHref(sha256: string): string {
  return `/api/v2/evidence/${sha256}`;
}

export function proofHref(statementDigest: string): string {
  return `/api/v2/proofs/${statementDigest}`;
}

function iso(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

function asArray<T>(value: Prisma.JsonValue | null | undefined): T[] {
  return Array.isArray(value) ? (value as unknown as T[]) : [];
}

// ---------------------------------------------------------------------------
// Evidence

export interface EvidenceLinkView {
  sha256: string;
  name: string | null;
  size: number | null;
  mediaType: string | null;
  /** The bytes are stored here and served at `href`. */
  stored: boolean;
  href: string;
}

async function storedDigests(digests: string[]) {
  if (digests.length === 0) return new Map<string, { size: number; mediaType: string; location: string | null }>();
  const blobs = await prisma.evidenceBlob.findMany({ where: { sha256: { in: [...new Set(digests)] } } });
  return new Map(blobs.map((blob) => [blob.sha256, blob]));
}

// ---------------------------------------------------------------------------
// Factory runs

export interface StageView {
  stageId: string;
  status: string;
  addedBy: string | null;
  kind: string | null;
  durationMs: number | null;
  log: EvidenceLinkView | null;
  artifacts: EvidenceLinkView[];
}

export interface ProofSummaryView {
  statementDigest: string;
  verdict: string | null;
  trust: string | null;
  signer: string | null;
  /** The envelope was received; false when only a commit or run names the digest. */
  received: boolean;
  href: string;
}

export interface CommitView {
  commitSha: string;
  tree: string;
  branch: string | null;
  proofDigest: string | null;
  committedAt: string;
}

export interface FactoryRunView {
  factoryRunId: string;
  attemptId: string | null;
  workUnitId: string | null;
  tree: string;
  verdict: string | null;
  status: string | null;
  policy: { id: string | null; digest: string | null; required: string[] };
  factoryLine: string | null;
  station: string | null;
  traceId: string | null;
  startedAt: string;
  finishedAt: string | null;
  sessions: unknown[];
  stages: StageView[];
  proof: ProofSummaryView | null;
  commits: CommitView[];
}

function stageView(stage: StageResult, blobs: Awaited<ReturnType<typeof storedDigests>>): StageView {
  const link = (sha256: string, name: string | null, size: number | null, mediaType: string | null): EvidenceLinkView => {
    const blob = blobs.get(sha256);
    return {
      sha256,
      name,
      size: size ?? blob?.size ?? null,
      mediaType: mediaType ?? blob?.mediaType ?? null,
      stored: Boolean(blob?.location),
      href: evidenceHref(sha256),
    };
  };
  const artifacts = asArray<{ name?: string; sha256?: string; size?: number; mediaType?: string }>(stage.artifacts)
    .filter((artifact) => typeof artifact.sha256 === 'string')
    .map((artifact) => link(artifact.sha256 as string, artifact.name ?? null, artifact.size ?? null, artifact.mediaType ?? null));
  const logArtifact = stage.logDigest ? artifacts.find((artifact) => artifact.sha256 === stage.logDigest) : undefined;
  return {
    stageId: stage.stageId,
    status: stage.status,
    addedBy: stage.addedBy,
    kind: stage.kind,
    durationMs: stage.durationMs,
    log: stage.logDigest ? (logArtifact ?? link(stage.logDigest, `${stage.stageId}.log`, null, null)) : null,
    artifacts,
  };
}

/** Factory runs with their stages, proof and commits. */
export async function factoryRunViews(runs: FactoryRun[]): Promise<FactoryRunView[]> {
  if (runs.length === 0) return [];
  const ids = runs.map((run) => run.factoryRunId);
  const [stages, attestations, commits] = await Promise.all([
    stagesOf(runs),
    prisma.attestation.findMany({ where: { factoryRunId: { in: ids } }, orderBy: { receivedAt: 'desc' } }),
    prisma.commitBinding.findMany({ where: { factoryRunId: { in: ids } }, orderBy: { committedAt: 'desc' } }),
  ]);
  const digests = [...stages.values()].flatMap((list) =>
    list.flatMap((stage) => [
      ...(stage.logDigest ? [stage.logDigest] : []),
      ...asArray<{ sha256?: string }>(stage.artifacts).flatMap((artifact) => (artifact.sha256 ? [artifact.sha256] : [])),
    ]),
  );
  const blobs = await storedDigests(digests);
  return runs.map((run) => {
    const attestation =
      attestations.find((row) => row.factoryRunId === run.factoryRunId && (!row.tree || row.tree === run.tree)) ?? null;
    const digest = attestation?.statementDigest ?? run.attestationDigest;
    return {
      factoryRunId: run.factoryRunId,
      attemptId: run.attemptId,
      workUnitId: run.workUnitId,
      tree: run.tree,
      verdict: run.verdict,
      status: run.status,
      policy: { id: run.policyId, digest: run.policyDigest, required: asArray<string>(run.policyRequired) },
      factoryLine: run.factoryLine,
      station: run.station,
      traceId: run.traceId,
      startedAt: run.startedAt.toISOString(),
      finishedAt: iso(run.finishedAt),
      sessions: asArray<unknown>(run.sessions),
      stages: (stages.get(run.factoryRunId) ?? []).map((stage) => stageView(stage, blobs)),
      proof: digest
        ? {
            statementDigest: digest,
            verdict: attestation?.verdict ?? run.verdict,
            trust: attestation?.trust ?? null,
            signer: attestation?.signer ?? null,
            received: Boolean(attestation),
            href: proofHref(digest),
          }
        : null,
      commits: commits
        .filter((commit) => commit.factoryRunId === run.factoryRunId)
        .map((commit) => ({
          commitSha: commit.commitSha,
          tree: commit.tree,
          branch: commit.branch,
          proofDigest: commit.proofDigest,
          committedAt: commit.committedAt.toISOString(),
        })),
    };
  });
}

export async function getFactoryRunView(factoryRunId: string): Promise<FactoryRunView | null> {
  const run = await prisma.factoryRun.findUnique({ where: { factoryRunId } });
  if (!run) return null;
  const [view] = await factoryRunViews([run]);
  return view;
}

// ---------------------------------------------------------------------------
// Usage and trajectory of an attempt

export interface ModelUsageView {
  model: string | null;
  agentTool: string;
  observations: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  tokensTotal: number;
  /** Null when no row of this model is priced (an unpriced tool or an unknown model). */
  costUsd: number | null;
  costSource: 'reported' | 'estimated' | 'mixed' | null;
  /** The genai-prices releases that priced the estimated rows. */
  pricedWith: string[];
}

export interface UsageView {
  /** Usage up to this instant (a run's `finishedAt`); null for the whole attempt. */
  until: string | null;
  tokensTotal: number;
  costUsd: number | null;
  byModel: ModelUsageView[];
}

type UsageRow = Pick<
  UsageObservation,
  | 'agentTool'
  | 'model'
  | 'observedAt'
  | 'tokensInput'
  | 'tokensOutput'
  | 'tokensCacheRead'
  | 'tokensCacheCreation'
  | 'costUsd'
  | 'costSource'
  | 'pricedWith'
>;

export function summarizeUsage(rows: UsageRow[], until: Date | null): UsageView {
  const byModel = new Map<string, ModelUsageView & { sources: Set<string>; versions: Set<string> }>();
  for (const row of rows) {
    if (until && row.observedAt > until) continue;
    const key = `${row.agentTool}\0${row.model ?? ''}`;
    const entry =
      byModel.get(key) ??
      {
        model: row.model,
        agentTool: row.agentTool,
        observations: 0,
        tokensInput: 0,
        tokensOutput: 0,
        tokensCacheRead: 0,
        tokensCacheCreation: 0,
        tokensTotal: 0,
        costUsd: null,
        costSource: null,
        pricedWith: [],
        sources: new Set<string>(),
        versions: new Set<string>(),
      };
    const tokens = [row.tokensInput, row.tokensOutput, row.tokensCacheRead, row.tokensCacheCreation].map(Number);
    entry.observations += 1;
    entry.tokensInput += tokens[0];
    entry.tokensOutput += tokens[1];
    entry.tokensCacheRead += tokens[2];
    entry.tokensCacheCreation += tokens[3];
    entry.tokensTotal += tokens.reduce((sum, value) => sum + value, 0);
    if (row.costUsd != null) {
      entry.costUsd = (entry.costUsd ?? 0) + Number(row.costUsd);
      entry.sources.add(row.costSource === 'estimated' ? 'estimated' : 'reported');
      if (row.costSource === 'estimated') entry.versions.add(row.pricedWith ?? GENAI_PRICES_LABEL);
    }
    byModel.set(key, entry);
  }
  const models = [...byModel.values()].map(({ sources, versions, ...entry }) => ({
    ...entry,
    costSource: sources.size > 1 ? ('mixed' as const) : ((([...sources][0] as 'reported' | 'estimated' | undefined) ?? null)),
    pricedWith: [...versions].sort(),
  }));
  const priced = models.filter((model) => model.costUsd != null);
  return {
    until: iso(until),
    tokensTotal: models.reduce((sum, model) => sum + model.tokensTotal, 0),
    costUsd: priced.length ? priced.reduce((sum, model) => sum + (model.costUsd ?? 0), 0) : null,
    byModel: models.sort((a, b) => b.tokensTotal - a.tokensTotal),
  };
}

const USAGE_SELECT = {
  id: true,
  agentTool: true,
  sessionId: true,
  model: true,
  observedAt: true,
  tokensInput: true,
  tokensOutput: true,
  tokensCacheRead: true,
  tokensCacheCreation: true,
  costUsd: true,
  costSource: true,
  pricedWith: true,
} as const;

/**
 * The usage units of an attempt: those stamped with `factory.attempt.id`, plus
 * unstamped units of a session while one of the attempt's segments was in
 * force (the CLI recorded that session context, ADR 0004 section 2).
 */
async function attemptUsageRows(attemptId: string, segments: Array<{ agentTool: string; sessionId: string; from: Date; to: Date | null }>) {
  const stamped = await prisma.usageObservation.findMany({ where: { attemptId }, select: USAGE_SELECT });
  const bySegment = segments.length
    ? await prisma.usageObservation.findMany({
        where: {
          attemptId: null,
          OR: segments.map((segment) => ({
            agentTool: segment.agentTool,
            sessionId: segment.sessionId,
            observedAt: { gte: segment.from, ...(segment.to ? { lt: segment.to } : {}) },
          })),
        },
        select: USAGE_SELECT,
      })
    : [];
  const seen = new Set<string>();
  return [...stamped, ...bySegment].filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

export interface TrajectoryEventView {
  at: string;
  eventType: string;
  agentTool: string;
  sessionKey: string;
  contentKind: string;
  contentLabel: string | null;
  traceId: string | null;
  spanId: string | null;
}

// ---------------------------------------------------------------------------
// Work unit

export interface AttemptView {
  attemptId: string;
  slotId: string;
  branch: string | null;
  baseCommit: string | null;
  startedAt: string;
  endedAt: string | null;
  repositoryId: string | null;
  sessions: Array<{ agentTool: string; sessionId: string; from: string; to: string | null; reason: string | null }>;
  factoryRuns: Array<FactoryRunView & { usage: UsageView; trajectoryEvents: number }>;
  usage: UsageView;
  trajectory: { count: number; events: TrajectoryEventView[] };
}

export interface WorkUnitView {
  workUnit: {
    workUnitId: string;
    repositoryUrl: string | null;
    repositoryId: string | null;
    source: string | null;
    url: string | null;
    title: string | null;
    parentWorkUnitId: string | null;
    links: unknown[];
    updatedAt: string;
  };
  attempts: AttemptView[];
}

async function attemptView(attempt: Attempt): Promise<AttemptView> {
  const [segments, runs, trajectoryCount, trajectory] = await Promise.all([
    prisma.sessionSegment.findMany({ where: { attemptId: attempt.attemptId, kind: 'segment' }, orderBy: { from: 'asc' } }),
    prisma.factoryRun.findMany({ where: { attemptId: attempt.attemptId }, orderBy: { startedAt: 'asc' } }),
    prisma.agentTrajectoryRecord.count({ where: { attemptId: attempt.attemptId } }),
    prisma.agentTrajectoryRecord.findMany({
      where: { attemptId: attempt.attemptId },
      orderBy: [{ eventTimestamp: 'desc' }, { sequence: 'desc' }],
      take: TRAJECTORY_EVENTS,
      select: {
        eventTimestamp: true,
        eventType: true,
        agentTool: true,
        sessionKey: true,
        contentKind: true,
        contentLabel: true,
        traceId: true,
        spanId: true,
      },
    }),
  ]);
  const [usageRows, runViews] = await Promise.all([attemptUsageRows(attempt.attemptId, segments), factoryRunViews(runs)]);
  const runCounts = await Promise.all(
    runs.map((run) =>
      run.finishedAt
        ? prisma.agentTrajectoryRecord.count({ where: { attemptId: attempt.attemptId, eventTimestamp: { lte: run.finishedAt } } })
        : Promise.resolve(trajectoryCount),
    ),
  );
  return {
    attemptId: attempt.attemptId,
    slotId: attempt.slotId,
    branch: attempt.branch,
    baseCommit: attempt.baseCommit,
    startedAt: attempt.startedAt.toISOString(),
    endedAt: iso(attempt.endedAt),
    repositoryId: attempt.repositoryId,
    sessions: segments.map((segment) => ({
      agentTool: segment.agentTool,
      sessionId: segment.sessionId,
      from: segment.from.toISOString(),
      to: iso(segment.to),
      reason: segment.reason,
    })),
    factoryRuns: runViews.map((view, index) => ({
      ...view,
      usage: summarizeUsage(usageRows, runs[index].finishedAt),
      trajectoryEvents: runCounts[index],
    })),
    usage: summarizeUsage(usageRows, null),
    trajectory: {
      count: trajectoryCount,
      events: trajectory.reverse().map((event) => ({
        at: event.eventTimestamp.toISOString(),
        eventType: event.eventType,
        agentTool: event.agentTool,
        sessionKey: event.sessionKey,
        contentKind: event.contentKind,
        contentLabel: event.contentLabel,
        traceId: event.traceId,
        spanId: event.spanId,
      })),
    },
  };
}

export type WorkUnitLookup =
  | { status: 'found'; view: WorkUnitView }
  | { status: 'not-found' }
  | { status: 'ambiguous'; repositories: Array<string | null> };

/**
 * A work unit by id. A work unit id is scoped to its repository: pass the
 * repository URL when several repositories use the same id.
 */
export async function getWorkUnitView(
  workUnitId: string,
  options: { repositoryUrl?: string | null } = {},
): Promise<WorkUnitLookup> {
  const units = await prisma.workUnit.findMany({
    where: {
      workUnitId,
      ...(options.repositoryUrl !== undefined ? { repositoryKey: recordRepositoryKey(options.repositoryUrl) } : {}),
    },
  });
  if (units.length === 0) return { status: 'not-found' };
  if (units.length > 1) return { status: 'ambiguous', repositories: units.map((unit) => unit.repositoryUrl) };
  return { status: 'found', view: await workUnitViewOf(units[0]) };
}

/** The view of one stored work unit. */
export async function workUnitViewOf(unit: WorkUnit): Promise<WorkUnitView> {
  const attempts = await prisma.attempt.findMany({
    where: { repositoryKey: unit.repositoryKey, workUnitId: unit.workUnitId },
    orderBy: { startedAt: 'desc' },
  });
  return {
    workUnit: {
      workUnitId: unit.workUnitId,
      repositoryUrl: unit.repositoryUrl,
      repositoryId: unit.repositoryId,
      source: unit.source,
      url: unit.sourceUrl,
      title: unit.title,
      parentWorkUnitId: unit.parentWorkUnitId,
      links: asArray<unknown>(unit.relatedLinks),
      updatedAt: unit.sourceUpdatedAt.toISOString(),
    },
    attempts: await Promise.all(attempts.map(attemptView)),
  };
}

// ---------------------------------------------------------------------------
// Proofs

export interface ProofView {
  statementDigest: string;
  payloadType: string;
  predicateType: string | null;
  factoryRunId: string | null;
  tree: string | null;
  verdict: string | null;
  trust: string | null;
  signer: string | null;
  receivedAt: string;
  envelope: unknown;
  /** The decoded in-toto statement. */
  statement: unknown;
  commits: CommitView[];
}

export async function getProofView(digest: string): Promise<ProofView | null> {
  const statementDigest = digest.startsWith('sha256:') ? digest : `sha256:${digest}`;
  const row = await prisma.attestation.findUnique({ where: { statementDigest } });
  if (!row) return null;
  const envelope = row.envelope as { payload?: string } | null;
  let statement: unknown = null;
  try {
    statement = envelope?.payload ? JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8')) : null;
  } catch {
    statement = null;
  }
  const commits = await prisma.commitBinding.findMany({
    where: { OR: [{ proofDigest: statementDigest }, ...(row.factoryRunId && row.tree ? [{ factoryRunId: row.factoryRunId, tree: row.tree }] : [])] },
    orderBy: { committedAt: 'desc' },
  });
  return {
    statementDigest: row.statementDigest,
    payloadType: row.payloadType,
    predicateType: row.predicateType,
    factoryRunId: row.factoryRunId,
    tree: row.tree,
    verdict: row.verdict,
    trust: row.trust,
    signer: row.signer,
    receivedAt: row.receivedAt.toISOString(),
    envelope: row.envelope,
    statement,
    commits: commits.map((commit) => ({
      commitSha: commit.commitSha,
      tree: commit.tree,
      branch: commit.branch,
      proofDigest: commit.proofDigest,
      committedAt: commit.committedAt.toISOString(),
    })),
  };
}
