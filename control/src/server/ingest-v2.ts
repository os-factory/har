import { placeFactoryRunsOfAttemptSafely } from '@/server/factory-run-placement';
import { createHash } from 'crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import {
  INGEST_V2_CONTRACT_VERSION,
  INGEST_V2_RECORD_TYPES,
  INGEST_V2_SIGNALS,
  IngestV2ProofsBodySchema,
  IngestV2RecordsBodySchema,
  ingestV2RecordKey,
  type DsseEnvelope,
  type IngestV2Capabilities,
  type IngestV2ProofsResponse,
  type IngestV2RecordOf,
  type IngestV2RecordsResponse,
} from '@har/schemas';
import { prisma } from '@/lib/db';
import { MAX_EVIDENCE_BYTES } from '@/server/evidence-store';
import { recordRepositoryKey, registeredRepositoryFor } from '@/server/repository-key';

/**
 * Mission Control as an ingest v2 receiver (ADR 0005): the reference
 * implementation of `POST v2/records` and `POST v2/proofs`. Every record is
 * upserted by its natural key and stored as sent; Mission Control never links
 * records itself (ADR 0004 section 6) beyond matching a repository URL to a
 * registered repository for display.
 */

export type Db = PrismaClient;
type WriteStatus = 'created' | 'updated' | 'unchanged';

export type IngestReply<T> = { status: 200; body: T } | { status: 400 | 422; body: { error: string; issues?: unknown } };

export function ingestV2Capabilities(): IngestV2Capabilities {
  return {
    contractVersion: INGEST_V2_CONTRACT_VERSION,
    signals: [...INGEST_V2_SIGNALS],
    recordTypes: [...INGEST_V2_RECORD_TYPES],
    proofs: true,
    evidence: true,
    maxEvidenceBytes: MAX_EVIDENCE_BYTES,
  };
}

// ---------------------------------------------------------------------------
// Comparison: a record sent again is `unchanged` when every stored field is equal.

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (value instanceof Prisma.Decimal) return value.toString();
  if (typeof value === 'bigint') return value.toString();
  if (value === undefined) return null;
  if (value === Prisma.JsonNull || value === Prisma.DbNull) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function sameFields(existing: Record<string, unknown>, data: Record<string, unknown>): boolean {
  return Object.keys(data).every(
    (key) => JSON.stringify(normalize(existing[key])) === JSON.stringify(normalize(data[key])),
  );
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function upsertBy<T extends Record<string, unknown>>(
  find: () => Promise<T | null>,
  create: () => Promise<unknown>,
  update: (existing: T) => Promise<unknown>,
  data: Record<string, unknown>,
): Promise<WriteStatus> {
  const existing = await find();
  if (!existing) {
    try {
      await create();
      return 'created';
    } catch (error) {
      // A concurrent delivery of the same record won the insert.
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
      const raced = await find();
      if (!raced) throw error;
      if (sameFields(raced, data)) return 'unchanged';
      await update(raced);
      return 'updated';
    }
  }
  if (sameFields(existing, data)) return 'unchanged';
  await update(existing);
  return 'updated';
}

// ---------------------------------------------------------------------------
// Records

async function attemptRepository(db: Db, attemptId: string | null | undefined) {
  if (!attemptId) return null;
  return db.attempt.findUnique({
    where: { attemptId },
    select: { repositoryId: true, repositoryKey: true, workUnitId: true },
  });
}

async function writeWorkUnit(db: Db, record: IngestV2RecordOf<'WorkUnit'>): Promise<WriteStatus> {
  const repositoryKey = recordRepositoryKey(record.repositoryUrl);
  const where = { repositoryKey_workUnitId: { repositoryKey, workUnitId: record.workUnitId } };
  const data = {
    repositoryUrl: record.repositoryUrl,
    source: record.source ?? null,
    sourceUrl: record.url ?? null,
    title: record.title ?? null,
    parentWorkUnitId: record.parentWorkUnitId ?? null,
    relatedLinks: json(record.links),
  };
  const now = new Date();
  return upsertBy(
    () => db.workUnit.findUnique({ where }),
    async () =>
      db.workUnit.create({
        data: {
          ...data,
          repositoryKey,
          workUnitId: record.workUnitId,
          repositoryId: await registeredRepositoryFor(db, record.repositoryUrl),
          sourceCreatedAt: now,
          sourceUpdatedAt: now,
        },
      }),
    (existing) =>
      db.workUnit.update({ where: { id: existing.id as string }, data: { ...data, sourceUpdatedAt: now } }),
    data,
  );
}

function slotNumber(slotId: string | null | undefined): number | null {
  if (!slotId || !/^\d+$/.test(slotId)) return null;
  return Number(slotId);
}

async function writeAttempt(db: Db, record: IngestV2RecordOf<'Attempt'>): Promise<WriteStatus> {
  const repositoryKey = recordRepositoryKey(record.repositoryUrl);
  const data = {
    workUnitId: record.workUnitId,
    repositoryKey,
    repositoryUrl: record.repositoryUrl,
    slotId: record.slotId,
    agentId: slotNumber(record.slotId),
    branch: record.branch,
    baseCommit: record.baseCommit,
    startedAt: new Date(record.startedAt),
    endedAt: record.endedAt ? new Date(record.endedAt) : null,
  };
  const status = await upsertBy(
    () => db.attempt.findUnique({ where: { attemptId: record.attemptId } }),
    async () =>
      db.attempt.create({
        data: {
          ...data,
          attemptId: record.attemptId,
          repositoryId: await registeredRepositoryFor(db, record.repositoryUrl, {
            attemptId: record.attemptId,
            branch: record.branch,
          }),
        },
      }),
    async (existing) =>
      db.attempt.update({
        where: { id: existing.id as string },
        data: {
          ...data,
          // A record without a repository URL never unscopes an attempt seen with one.
          ...(record.repositoryUrl
            ? {}
            : { repositoryKey: existing.repositoryKey as string, repositoryUrl: existing.repositoryUrl as string | null }),
          repositoryId:
            (existing.repositoryId as string | null) ??
            (await registeredRepositoryFor(db, record.repositoryUrl, { attemptId: record.attemptId, branch: record.branch })),
        },
      }),
    data,
  );
  // Factory runs that arrived before their attempt learn where they ran.
  await placeFactoryRunsOfAttemptSafely(record.attemptId, db);
  // A work unit seen before its first attempt takes the attempt's registered repository.
  if (record.workUnitId && status !== 'unchanged') {
    const attempt = await attemptRepository(db, record.attemptId);
    if (attempt?.repositoryId) {
      await db.workUnit.updateMany({
        where: { repositoryKey, workUnitId: record.workUnitId, repositoryId: null },
        data: { repositoryId: attempt.repositoryId },
      });
    }
  }
  return status;
}

async function writeSessionSegment(db: Db, record: IngestV2RecordOf<'SessionSegment'>): Promise<WriteStatus> {
  const segmentKey = ingestV2RecordKey(record);
  const attempt = await attemptRepository(db, record.attemptId);
  const attrs = record.attributes;
  const data = {
    agentTool: record.agentTool,
    sessionId: record.sessionId,
    kind: 'segment',
    attemptId: record.attemptId,
    workUnitId: attrs['factory.work_unit.id'] ?? attempt?.workUnitId ?? null,
    slotId: slotNumber(attrs['factory.slot.id']),
    branch: attrs['vcs.ref.head.name'] ?? null,
    from: new Date(record.from),
    to: record.to ? new Date(record.to) : null,
    reason: record.reason,
    attributes: json(attrs),
  };
  return upsertBy(
    () => db.sessionSegment.findUnique({ where: { segmentKey } }),
    () =>
      db.sessionSegment.create({
        data: { ...data, segmentKey, origin: 'record', repositoryId: attempt?.repositoryId ?? null },
      }),
    (existing) =>
      db.sessionSegment.update({
        where: { id: existing.id as string },
        data: { ...data, repositoryId: (existing.repositoryId as string | null) ?? attempt?.repositoryId ?? null },
      }),
    data,
  );
}

type SessionRef = IngestV2RecordOf<'FactoryRun'>['sessions'][number];

/** Session refs are merged, never replaced, when the same tree is verified again (ADR 0004 section 4). */
export function mergeSessionRefs(stored: unknown, incoming: SessionRef[]): SessionRef[] {
  const out = new Map<string, SessionRef>();
  const key = (ref: SessionRef) => JSON.stringify([ref.agentTool, ref.sessionId, new Date(ref.from).toISOString()]);
  for (const ref of Array.isArray(stored) ? (stored as SessionRef[]) : []) {
    if (ref && typeof ref === 'object' && typeof ref.sessionId === 'string') out.set(key(ref), ref);
  }
  for (const ref of incoming) {
    const previous = out.get(key(ref));
    out.set(key(ref), previous ? { ...previous, ...ref, ranVerify: previous.ranVerify || ref.ranVerify } : ref);
  }
  return [...out.values()].sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
}

async function writeFactoryRun(db: Db, record: IngestV2RecordOf<'FactoryRun'>): Promise<WriteStatus> {
  const attempt = await attemptRepository(db, record.attemptId);
  const proof = await db.attestation.findFirst({
    where: { factoryRunId: record.factoryRunId, tree: record.tree },
    orderBy: { receivedAt: 'desc' },
    select: { statementDigest: true },
  });
  const existing = await db.factoryRun.findUnique({ where: { factoryRunId: record.factoryRunId } });
  const data = {
    attemptId: record.attemptId,
    workUnitId: attempt?.workUnitId ?? existing?.workUnitId ?? null,
    repositoryKey: attempt?.repositoryKey ?? existing?.repositoryKey ?? '',
    tree: record.tree,
    verdict: record.verdict,
    status: record.verdict,
    full: true,
    policyId: record.policy.id,
    policyDigest: record.policy.digest ?? null,
    policyRequired: json(record.policy.required),
    factoryLine: record.factoryLine ?? null,
    station: record.station ?? null,
    traceId: record.traceId,
    startedAt: new Date(record.startedAt),
    finishedAt: new Date(record.finishedAt),
    sessions: json(mergeSessionRefs(existing?.sessions, record.sessions)),
    stageIds: json(record.stages),
    attestationDigest: proof?.statementDigest ?? existing?.attestationDigest ?? null,
  };
  const status = await upsertBy(
    async () => existing,
    () =>
      db.factoryRun.create({
        data: { ...data, factoryRunId: record.factoryRunId, repositoryId: attempt?.repositoryId ?? null },
      }),
    (row) =>
      db.factoryRun.update({
        where: { id: row.id },
        data: { ...data, repositoryId: row.repositoryId ?? attempt?.repositoryId ?? null },
      }),
    data,
  );
  await placeFactoryRunsOfAttemptSafely(record.attemptId, db);
  return status;
}

async function writeStageResult(db: Db, record: IngestV2RecordOf<'StageResult'>): Promise<WriteStatus> {
  const where = { factoryRunId_stageId: { factoryRunId: record.factoryRunId, stageId: record.stageId } };
  const data = {
    status: record.status,
    addedBy: record.addedBy,
    kind: record.kind ?? null,
    durationMs: record.durationMs,
    logDigest: record.logDigest,
    artifacts: json(record.artifacts),
  };
  return upsertBy(
    () => db.stageResult.findUnique({ where }),
    () => db.stageResult.create({ data: { ...data, factoryRunId: record.factoryRunId, stageId: record.stageId } }),
    (existing) => db.stageResult.update({ where: { id: existing.id as string }, data }),
    data,
  );
}

async function writeCommitBinding(db: Db, record: IngestV2RecordOf<'CommitBinding'>): Promise<WriteStatus> {
  const run = await db.factoryRun.findUnique({
    where: { factoryRunId: record.factoryRunId },
    select: { repositoryId: true },
  });
  const data = {
    tree: record.tree,
    factoryRunId: record.factoryRunId,
    proofDigest: record.proofDigest,
    branch: record.branch,
  };
  return upsertBy(
    () => db.commitBinding.findUnique({ where: { commitSha: record.commitSha } }),
    () =>
      db.commitBinding.create({
        data: { ...data, commitSha: record.commitSha, repositoryId: run?.repositoryId ?? null, committedAt: new Date() },
      }),
    (existing) =>
      db.commitBinding.update({
        where: { id: existing.id as string },
        data: { ...data, repositoryId: (existing.repositoryId as string | null) ?? run?.repositoryId ?? null },
      }),
    data,
  );
}

async function writeEvidenceBlob(db: Db, record: IngestV2RecordOf<'EvidenceBlob'>): Promise<WriteStatus> {
  // `location` is the receiver's to set, never the sender's.
  const data = { size: record.size, mediaType: record.mediaType };
  return upsertBy(
    () => db.evidenceBlob.findUnique({ where: { sha256: record.sha256 } }),
    () => db.evidenceBlob.create({ data: { ...data, sha256: record.sha256 } }),
    () => db.evidenceBlob.update({ where: { sha256: record.sha256 }, data }),
    data,
  );
}

// ---------------------------------------------------------------------------
// Proofs

export interface DecodedProof {
  statementDigest: string;
  payloadType: string;
  predicateType: string | null;
  factoryRunId: string | null;
  tree: string | null;
  verdict: string | null;
  trust: string | null;
  signer: string | null;
}

export class InvalidProofError extends Error {}

function field(value: unknown, ...path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function textField(value: unknown, ...path: string[]): string | null {
  const out = field(value, ...path);
  return typeof out === 'string' && out ? out : null;
}

/** The statement digest is recomputed from the payload bytes: `sha256:` + hex (Factory Commits). */
export function decodeProofEnvelope(envelope: DsseEnvelope): DecodedProof {
  const bytes = Buffer.from(envelope.payload, 'base64');
  const statementDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  let statement: unknown;
  try {
    statement = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new InvalidProofError('the envelope payload is not a JSON statement');
  }
  const subjects = field(statement, 'subject');
  const firstSubject = Array.isArray(subjects) ? subjects[0] : undefined;
  const signer = envelope.signatures.find((signature) => signature.keyid)?.keyid ?? null;
  return {
    statementDigest,
    payloadType: envelope.payloadType,
    predicateType: textField(statement, 'predicateType'),
    factoryRunId: textField(statement, 'predicate', 'run', 'id'),
    tree: textField(firstSubject, 'digest', 'gitTree'),
    verdict: textField(statement, 'predicate', 'verdict'),
    trust: textField(statement, 'predicate', 'environment', 'trust'),
    signer,
  };
}

async function linkProof(db: Db, proof: DecodedProof): Promise<void> {
  if (!proof.factoryRunId) return;
  await db.factoryRun.updateMany({
    where: { factoryRunId: proof.factoryRunId, ...(proof.tree ? { tree: proof.tree } : {}) },
    data: { attestationDigest: proof.statementDigest },
  });
  if (proof.tree) {
    await db.commitBinding.updateMany({
      where: { factoryRunId: proof.factoryRunId, tree: proof.tree, proofDigest: null },
      data: { proofDigest: proof.statementDigest },
    });
  }
}

async function writeAttestation(
  db: Db,
  envelope: DsseEnvelope,
  overrides: Partial<Omit<DecodedProof, 'statementDigest' | 'payloadType' | 'predicateType'>> = {},
): Promise<{ statementDigest: string; status: WriteStatus }> {
  const decoded = decodeProofEnvelope(envelope);
  const proof = { ...decoded, ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v != null)) } as DecodedProof;
  const run = proof.factoryRunId
    ? await db.factoryRun.findUnique({ where: { factoryRunId: proof.factoryRunId }, select: { repositoryId: true } })
    : null;
  const data = {
    envelope: json(envelope),
    payloadType: proof.payloadType,
    predicateType: proof.predicateType,
    factoryRunId: proof.factoryRunId,
    tree: proof.tree,
    verdict: proof.verdict,
    trust: proof.trust,
    signer: proof.signer,
  };
  const status = await upsertBy(
    () => db.attestation.findUnique({ where: { statementDigest: proof.statementDigest } }),
    () =>
      db.attestation.create({
        data: { ...data, statementDigest: proof.statementDigest, repositoryId: run?.repositoryId ?? null },
      }),
    (existing) =>
      db.attestation.update({
        where: { id: existing.id as string },
        data: { ...data, repositoryId: (existing.repositoryId as string | null) ?? run?.repositoryId ?? null },
      }),
    data,
  );
  await linkProof(db, proof);
  return { statementDigest: proof.statementDigest, status };
}

async function writeAttestationRecord(db: Db, record: IngestV2RecordOf<'Attestation'>): Promise<WriteStatus> {
  const recomputed = decodeProofEnvelope(record.envelope).statementDigest;
  if (recomputed !== record.statementDigest) {
    throw new InvalidProofError(
      `Attestation ${record.statementDigest}: the envelope payload digests to ${recomputed}`,
    );
  }
  const { status } = await writeAttestation(db, record.envelope, {
    factoryRunId: record.factoryRunId,
    tree: record.tree,
    verdict: record.verdict,
    trust: record.trust,
    signer: record.signer,
  });
  return status;
}

// ---------------------------------------------------------------------------
// Entry points

function invalid(error: { issues: unknown }, what: string): IngestReply<never> {
  return { status: 400, body: { error: `not a valid ${what} body`, issues: error.issues } };
}

/** `POST v2/records`: upsert each record by its natural key, in order. */
export async function ingestV2Records(input: unknown, db: Db = prisma): Promise<IngestReply<IngestV2RecordsResponse>> {
  const parsed = IngestV2RecordsBodySchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error, 'v2/records');
  // A wrong proof digest rejects the batch before anything is written.
  for (const record of parsed.data.records) {
    if (record.type !== 'Attestation') continue;
    try {
      const recomputed = decodeProofEnvelope(record.envelope).statementDigest;
      if (recomputed !== record.statementDigest) {
        return {
          status: 422,
          body: { error: `Attestation ${record.statementDigest}: the envelope payload digests to ${recomputed}` },
        };
      }
    } catch (error) {
      return { status: 422, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  }
  const results: NonNullable<IngestV2RecordsResponse['results']> = [];
  for (const record of parsed.data.records) {
    let status: WriteStatus;
    switch (record.type) {
      case 'WorkUnit':
        status = await writeWorkUnit(db, record);
        break;
      case 'Attempt':
        status = await writeAttempt(db, record);
        break;
      case 'SessionSegment':
        status = await writeSessionSegment(db, record);
        break;
      case 'FactoryRun':
        status = await writeFactoryRun(db, record);
        break;
      case 'StageResult':
        status = await writeStageResult(db, record);
        break;
      case 'CommitBinding':
        status = await writeCommitBinding(db, record);
        break;
      case 'Attestation':
        status = await writeAttestationRecord(db, record);
        break;
      case 'EvidenceBlob':
        status = await writeEvidenceBlob(db, record);
        break;
    }
    results.push({ type: record.type, key: ingestV2RecordKey(record), status });
  }
  return { status: 200, body: { results } };
}

/** `POST v2/proofs`: store each DSSE envelope by the digest Mission Control recomputes, and link it to its factory run. */
export async function ingestV2Proofs(input: unknown, db: Db = prisma): Promise<IngestReply<IngestV2ProofsResponse>> {
  const parsed = IngestV2ProofsBodySchema.safeParse(input);
  if (!parsed.success) return invalid(parsed.error, 'v2/proofs');
  for (const envelope of parsed.data.envelopes) {
    try {
      decodeProofEnvelope(envelope);
    } catch (error) {
      return { status: 422, body: { error: error instanceof Error ? error.message : String(error) } };
    }
  }
  const results: NonNullable<IngestV2ProofsResponse['results']> = [];
  for (const envelope of parsed.data.envelopes) {
    results.push(await writeAttestation(db, envelope));
  }
  return { status: 200, body: { results } };
}

/** How many rows hold `record`'s natural key (the contract's "no duplicates" read-back). */
export async function countV2Records(record: Parameters<typeof ingestV2RecordKey>[0], db: Db = prisma): Promise<number> {
  switch (record.type) {
    case 'WorkUnit':
      return db.workUnit.count({
        where: { repositoryKey: recordRepositoryKey(record.repositoryUrl), workUnitId: record.workUnitId },
      });
    case 'Attempt':
      return db.attempt.count({ where: { attemptId: record.attemptId } });
    case 'SessionSegment':
      return db.sessionSegment.count({ where: { segmentKey: ingestV2RecordKey(record) } });
    case 'FactoryRun':
      return db.factoryRun.count({ where: { factoryRunId: record.factoryRunId } });
    case 'StageResult':
      return db.stageResult.count({ where: { factoryRunId: record.factoryRunId, stageId: record.stageId } });
    case 'CommitBinding':
      return db.commitBinding.count({ where: { commitSha: record.commitSha } });
    case 'Attestation':
      return db.attestation.count({ where: { statementDigest: record.statementDigest } });
    case 'EvidenceBlob':
      return db.evidenceBlob.count({ where: { sha256: record.sha256 } });
  }
}
