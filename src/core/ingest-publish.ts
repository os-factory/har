import * as path from 'path';
import {
  DsseEnvelopeSchema,
  INGEST_V2_MAX_RECORDS_PER_BATCH,
  IngestV2RecordSchema,
  type DsseEnvelope,
  type HarDestination,
  type IngestV2Record,
  type ValidationRecord,
} from '../harness/schema';
import { getArtifactsDir } from '../harness/stages';
import { isRepoPortalSyncEnabled } from './control-registry';
import {
  drainIngestQueues,
  enqueueIngest,
  getIngestQueueRoot,
  type DrainResult,
  type EvidenceFileRef,
} from './ingest-queue';
import { resolvePortalTarget } from './portal-targets';
import {
  FACTORY_PROOF_POLICY_ID,
  attestationFilePath,
  readAttestationEntry,
  readPolicyDigest,
  verificationTraceId,
} from './proof';
import { SEGMENT_ATTR, listSessionContexts, segmentBelongsTo, slotRepositoryUrl, type SegmentOccupancy } from './session-context';
import { slotArtifactsRoot } from './stage-evidence';
import { enabledDestinations } from './telemetry-destinations';
import { isControlAvailable } from './telemetry-route';
import { findWorkAttempt, findWorkUnit } from './work-units';

/**
 * The CLI sends records, proofs and evidence directly to every receiver
 * (ADR 0004 section 6, ADR 0005 sections 2-4): after launch, on
 * teardown/complete, on verify and on commit. Each send is mapped to the
 * ingest v2 Zod schemas, validated, queued per destination and drained within
 * a short budget. Nothing here throws or blocks the command that triggered it.
 */

export type IngestCapability = 'records' | 'proofs' | 'evidence';

/** Budget of the drain that follows a send (the rest is retried by later commands). */
export const PUBLISH_DRAIN_BUDGET_MS = 2_500;

export interface PublishOptions {
  env?: NodeJS.ProcessEnv;
  /** Repository the data belongs to; a hosted receiver gets only repos attached to it. */
  repoPath?: string;
  fetchImpl?: typeof fetch;
  budgetMs?: number;
  /** Destinations to consider (tests); default: the enabled destination list. */
  destinations?: readonly HarDestination[];
  /** Skip the drain after queueing (tests). */
  drain?: boolean;
}

/** Whether a receiver takes data from this repository now. */
function receiverAccepts(destination: HarDestination, options: PublishOptions): boolean {
  const env = options.env ?? process.env;
  if (destination.preset === 'mission-control') {
    return env.HAR_CONTROL_DISABLED !== 'true' && isControlAvailable(env);
  }
  if (destination.preset === 'hq' && options.repoPath) {
    // HAR HQ receives only repositories attached to the connection (or the HAR_PORTAL_URL/TOKEN override).
    try {
      return resolvePortalTarget(options.repoPath) !== null && isRepoPortalSyncEnabled(options.repoPath);
    } catch {
      return false;
    }
  }
  return true;
}

/** Enabled ingest receivers that take a capability for this repository. */
export function ingestReceiversFor(capability: IngestCapability, options: PublishOptions = {}): HarDestination[] {
  const list = options.destinations ?? enabledDestinations(options.env);
  return list.filter(
    (destination) =>
      destination.enabled &&
      (destination.preset === 'mission-control' || destination.preset === 'hq') &&
      destination[capability] &&
      receiverAccepts(destination, options),
  );
}

/** Keep the records that parse with the ingest v2 schemas (parsed: unknown fields stripped). */
export function validIngestRecords(records: readonly unknown[]): IngestV2Record[] {
  const out: IngestV2Record[] = [];
  for (const record of records) {
    const parsed = IngestV2RecordSchema.safeParse(record);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

export interface IngestPublishBatch {
  records?: readonly unknown[];
  proofs?: readonly DsseEnvelope[];
  evidence?: { files: readonly EvidenceFileRef[]; sources: ReadonlyMap<string, string> };
}

export interface PublishResult {
  /** Destination names something was queued for. */
  queued: string[];
  drain?: DrainResult;
}

/**
 * Queue a batch for every receiver that takes it, in order (records, proofs,
 * evidence), without sending. Returns the destinations queued for. Never throws.
 */
export function queueIngest(batch: IngestPublishBatch, options: PublishOptions = {}): string[] {
  const queued = new Set<string>();
  try {
    const env = options.env ?? process.env;
    if (!getIngestQueueRoot(env)) return [];
    const records = validIngestRecords(batch.records ?? []);
    const proofs = (batch.proofs ?? []).filter((envelope) => DsseEnvelopeSchema.safeParse(envelope).success);
    const evidence = batch.evidence?.files ?? [];
    if (records.length > 0) {
      for (const destination of ingestReceiversFor('records', options)) {
        for (let index = 0; index < records.length; index += INGEST_V2_MAX_RECORDS_PER_BATCH) {
          const chunk = records.slice(index, index + INGEST_V2_MAX_RECORDS_PER_BATCH);
          if (enqueueIngest(destination.name, 'records', { records: chunk }, { env })) queued.add(destination.name);
        }
      }
    }
    if (proofs.length > 0) {
      for (const destination of ingestReceiversFor('proofs', options)) {
        if (enqueueIngest(destination.name, 'proofs', { envelopes: [...proofs] }, { env })) queued.add(destination.name);
      }
    }
    if (evidence.length > 0 && batch.evidence) {
      for (const destination of ingestReceiversFor('evidence', options)) {
        if (enqueueIngest(destination.name, 'evidence', { files: [...evidence] }, { env, sources: batch.evidence.sources })) {
          queued.add(destination.name);
        }
      }
    }
  } catch {
    // fail-open
  }
  return [...queued];
}

/**
 * Queue a batch for every receiver that takes it, then drain those receivers
 * within the budget (what is left is retried by later commands). Never throws.
 */
export async function publishIngest(batch: IngestPublishBatch, options: PublishOptions = {}): Promise<PublishResult> {
  const queued = queueIngest(batch, options);
  if (queued.length === 0 || options.drain === false) return { queued };
  try {
    const drain = await drainIngestQueues({
      env: options.env ?? process.env,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      budgetMs: options.budgetMs ?? PUBLISH_DRAIN_BUDGET_MS,
      destinations: queued,
    });
    return { queued, drain };
  } catch {
    return { queued };
  }
}

// ---------------------------------------------------------------------------
// Record builders (P0 schemas; invalid records are dropped by publishIngest)
// ---------------------------------------------------------------------------

function nullable(value: string | undefined | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function buildWorkUnitRecord(harnessRoot: string, workUnitId: string, repositoryUrl: string | null): unknown {
  const unit = findWorkUnit(harnessRoot, workUnitId);
  if (!unit) return undefined;
  return {
    type: 'WorkUnit',
    workUnitId,
    repositoryUrl,
    source: nullable(unit.source),
    url: nullable(unit.sourceUrl),
    title: nullable(unit.title),
    parentWorkUnitId: nullable(unit.parentWorkUnitId),
    links: (unit.relatedLinks ?? []).map((link) => ({
      source: link.source,
      url: link.url,
      label: nullable((link as { label?: string }).label),
    })),
  };
}

export function buildAttemptRecord(harnessRoot: string, attemptId: string, repositoryUrl: string | null): unknown {
  const attempt = findWorkAttempt(harnessRoot, attemptId);
  if (!attempt) return undefined;
  return {
    type: 'Attempt',
    attemptId,
    workUnitId: attempt.workUnitId ?? null,
    repositoryUrl,
    slotId: String(attempt.agentId),
    branch: attempt.branch,
    baseCommit: attempt.baseCommit,
    startedAt: attempt.createdAt,
    endedAt: attempt.endedAt ?? null,
  };
}

/** Every session segment of an occupancy, from the session context files. */
export function buildSegmentRecords(occupancy: SegmentOccupancy, home?: string): unknown[] {
  const out: unknown[] = [];
  for (const { context } of listSessionContexts(home)) {
    for (const segment of context.segments) {
      if (!segmentBelongsTo(segment, occupancy)) continue;
      out.push({
        type: 'SessionSegment',
        agentTool: context.agentTool,
        sessionId: context.sessionId,
        attemptId: segment.attributes[SEGMENT_ATTR.attemptId] ?? null,
        ...segment,
      });
    }
  }
  return out;
}

/** The factory run (validation record) and its stage results. */
export function buildFactoryRunRecords(validation: ValidationRecord, options: {
  harnessRoot: string;
  attemptId?: string;
}): unknown[] {
  const stages = validation.stageResults ?? [];
  const digest = readPolicyDigest(options.harnessRoot);
  const factoryRun = {
    type: 'FactoryRun',
    factoryRunId: validation.validationId,
    attemptId: options.attemptId ?? null,
    tree: validation.treeHash,
    verdict: validation.status === 'pass' ? 'pass' : 'fail',
    policy: {
      id: FACTORY_PROOF_POLICY_ID,
      digest: digest ?? null,
      required: stages.filter((stage) => stage.addedBy === 'policy').map((stage) => stage.stageId),
    },
    factoryLine: validation.factoryLine ?? null,
    station: validation.station ?? null,
    traceId: verificationTraceId(validation.validationId),
    startedAt: validation.startedAt ?? validation.createdAt,
    finishedAt: validation.finishedAt ?? validation.updatedAt,
    sessions: validation.sessions ?? [],
    stages: stages.map((stage) => stage.stageId),
  };
  return [
    factoryRun,
    ...stages.map((stage) => ({
      type: 'StageResult',
      factoryRunId: validation.validationId,
      stageId: stage.stageId,
      status: stage.status,
      addedBy: stage.addedBy,
      kind: stage.kind ?? null,
      durationMs: stage.durationMs,
      logDigest: stage.logDigest,
      artifacts: stage.artifacts,
    })),
  ];
}

// ---------------------------------------------------------------------------
// Lifecycle events
// ---------------------------------------------------------------------------

interface SlotSessionLike {
  agentId: number;
  attemptId?: string;
  workUnitId?: string;
  branch?: string;
  workDir?: string;
}

function occupancyOf(session: SlotSessionLike, harnessRoot: string): SegmentOccupancy {
  return {
    attemptId: session.attemptId,
    slotId: String(session.agentId),
    branch: session.branch,
    repositoryUrl: slotRepositoryUrl(session.workDir, harnessRoot),
  };
}

export interface SlotRecordsInput {
  harnessRoot: string;
  session: SlotSessionLike;
  /** An attempt the slot just left (work-bind): its end and closed segments are sent too. */
  endedAttemptId?: string;
}

/** The work unit, the attempt (with its end once ended) and every session segment of the slot's occupancy. */
export function slotRecordsBatch(input: SlotRecordsInput): IngestPublishBatch {
  try {
    const occupancy = occupancyOf(input.session, input.harnessRoot);
    const repositoryUrl = occupancy.repositoryUrl ?? null;
    const records: unknown[] = [];
    if (input.session.workUnitId) records.push(buildWorkUnitRecord(input.harnessRoot, input.session.workUnitId, repositoryUrl));
    if (input.endedAttemptId && input.endedAttemptId !== input.session.attemptId) {
      records.push(buildAttemptRecord(input.harnessRoot, input.endedAttemptId, repositoryUrl));
      records.push(...buildSegmentRecords({ ...occupancy, attemptId: input.endedAttemptId }));
    }
    if (input.session.attemptId) records.push(buildAttemptRecord(input.harnessRoot, input.session.attemptId, repositoryUrl));
    records.push(...buildSegmentRecords(occupancy));
    return { records: records.filter((record) => record !== undefined) };
  } catch {
    return {};
  }
}

/** Launch, teardown, complete: send the slot's records to every receiver. */
export async function publishSlotRecords(input: SlotRecordsInput, options: PublishOptions = {}): Promise<PublishResult> {
  if (!getIngestQueueRoot(options.env)) return { queued: [] };
  return publishIngest(slotRecordsBatch(input), { repoPath: input.harnessRoot, ...options });
}

/** `work-bind` (synchronous): queue the slot's records; the command's final drain sends them. */
export function queueSlotRecords(input: SlotRecordsInput, options: PublishOptions = {}): string[] {
  if (!getIngestQueueRoot(options.env)) return [];
  return queueIngest(slotRecordsBatch(input), { repoPath: input.harnessRoot, ...options });
}

/**
 * Verify: the factory run and its stage results, then the proof (DSSE) when
 * one was attested, then the evidence it lists. Evidence bytes are copied into
 * each destination's queue now: the slot work dir is deleted on teardown.
 */
export async function publishFactoryRun(
  input: {
    harnessRoot: string;
    checkoutDir: string;
    validation: ValidationRecord;
    /** Slot work dir holding `.har/<artifactsDir>/` (default: the checkout). */
    workDir?: string;
    attemptId?: string;
    /** Upload the evidence (ADR 0005 §4: after a passing full verify). Default true. */
    evidence?: boolean;
  },
  options: PublishOptions = {},
): Promise<PublishResult> {
  if (!getIngestQueueRoot(options.env)) return { queued: [] };
  try {
    const records = buildFactoryRunRecords(input.validation, {
      harnessRoot: input.harnessRoot,
      attemptId: input.attemptId,
    });
    const proofs: DsseEnvelope[] = [];
    if (input.validation.attestationDigest) {
      const entry = readAttestationEntry(attestationFilePath(input.checkoutDir, input.validation.treeHash));
      const envelope = entry && entry.digest === input.validation.attestationDigest
        ? DsseEnvelopeSchema.safeParse(entry.envelope)
        : undefined;
      if (envelope?.success) proofs.push(envelope.data);
    }
    let artifactsDir = 'artifacts';
    try {
      artifactsDir = getArtifactsDir(input.harnessRoot);
    } catch {
      // no readable stage registry: the default directory
    }
    const artifactsRoot = slotArtifactsRoot(input.workDir ?? input.checkoutDir, artifactsDir);
    const files = new Map<string, EvidenceFileRef>();
    const sources = new Map<string, string>();
    for (const stage of input.evidence === false ? [] : (input.validation.stageResults ?? [])) {
      for (const artifact of stage.artifacts) {
        if (files.has(artifact.sha256)) continue;
        files.set(artifact.sha256, { sha256: artifact.sha256, size: artifact.size, mediaType: artifact.mediaType });
        sources.set(artifact.sha256, path.join(artifactsRoot, artifact.name));
      }
    }
    return await publishIngest(
      {
        records,
        proofs,
        ...(files.size > 0 ? { evidence: { files: [...files.values()], sources } } : {}),
      },
      { repoPath: input.harnessRoot, ...options },
    );
  } catch {
    return { queued: [] };
  }
}

/** Commit hook: the commit binding of a commit whose tree has a factory run. */
export async function publishCommitBinding(
  input: {
    harnessRoot: string;
    commitSha: string;
    treeHash: string;
    validation: Pick<ValidationRecord, 'validationId' | 'attestationDigest'>;
    branch?: string;
  },
  options: PublishOptions = {},
): Promise<PublishResult> {
  if (!getIngestQueueRoot(options.env)) return { queued: [] };
  return publishIngest(
    {
      records: [
        {
          type: 'CommitBinding',
          commitSha: input.commitSha,
          tree: input.treeHash,
          factoryRunId: input.validation.validationId,
          proofDigest: input.validation.attestationDigest ?? null,
          branch: nullable(input.branch),
        },
      ],
    },
    { repoPath: input.harnessRoot, ...options },
  );
}
