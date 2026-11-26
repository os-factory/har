import { z } from 'zod';
import {
  isSegmentIntervalValid,
  SESSION_CONTEXT_ATTEMPT_ATTR,
  SESSION_SEGMENT_SHAPE,
  SessionContextAgentToolSchema,
  SessionContextSessionIdSchema,
} from './session-context';
import { OTLP_SIGNALS } from './telemetry-destinations';

/**
 * Ingest contract v2 (ADR 0005): what the HAR CLI sends to every receiver
 * (Mission Control, a hosted receiver, a third-party implementation), and what a
 * receiver answers. One contract for every receiver; a receiver never forwards
 * to another.
 *
 * Paths are relative to the receiver's ingest base URL (Mission Control:
 * `http://localhost:3847/api`). Every record carries its natural key, every id is
 * a string, and sending a record again is a no-op (idempotent upsert by key).
 * Unknown fields are stripped on parse, so a newer CLI can add optional fields.
 */

export const INGEST_V2_CONTRACT_VERSION = '2' as const;

/** Endpoint paths, relative to the ingest base URL (no leading slash). */
export const INGEST_V2_PATHS = {
  capabilities: 'v2/capabilities',
  records: 'v2/records',
  proofs: 'v2/proofs',
  evidenceMissing: 'v2/evidence/missing',
  /** `PUT v2/evidence/{sha256}` */
  evidencePrefix: 'v2/evidence/',
  otlpTraces: 'otel/v1/traces',
  otlpLogs: 'otel/v1/logs',
  otlpMetrics: 'otel/v1/metrics',
} as const;

/** `v2/evidence/<sha256>` */
export function ingestV2EvidencePath(sha256: string): string {
  return `${INGEST_V2_PATHS.evidencePrefix}${Sha256HexSchema.parse(sha256)}`;
}

/** Record types of `POST v2/records`, in dependency order (ADR 0005 section 3). Single source of truth. */
export const INGEST_V2_RECORD_TYPES = [
  'WorkUnit',
  'Attempt',
  'SessionSegment',
  'FactoryRun',
  'StageResult',
  'CommitBinding',
  'Attestation',
  'EvidenceBlob',
] as const;
export type IngestV2RecordType = (typeof INGEST_V2_RECORD_TYPES)[number];

/** OTLP signals a receiver may accept (`otel/v1/<signal>`). */
export const INGEST_V2_SIGNALS = OTLP_SIGNALS;
export type IngestV2Signal = (typeof INGEST_V2_SIGNALS)[number];

/** Factory Commits stage statuses (`predicate.stages[].status`). */
export const INGEST_V2_STAGE_STATUSES = ['passed', 'failed', 'error', 'skipped'] as const;
/** Who required a stage (`predicate.stages[].addedBy`). */
export const INGEST_V2_STAGE_ADDED_BY = ['policy', 'agent'] as const;
export const INGEST_V2_VERDICTS = ['pass', 'fail'] as const;
export const INGEST_V2_TRUST_LEVELS = ['self-reported', 'independent'] as const;

/** Largest batch a receiver must accept in one `POST v2/records`. */
export const INGEST_V2_MAX_RECORDS_PER_BATCH = 500;

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** Lowercase hex SHA-256 (evidence blobs, log and artifact digests). */
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);
/** `sha256:<hex>`: a Factory Commits statement digest. */
export const StatementDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** Git object id (SHA-1 or SHA-256 repositories). */
export const GitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
/** OTel trace id: 32 lowercase hex chars. */
export const TraceIdSchema = z.string().regex(/^[0-9a-f]{32}$/);
/** An id: no whitespace and no `;` (Factory Commits token). */
export const IngestV2IdSchema = z.string().min(1).max(256).regex(/^[^\s;]+$/);
export const IngestV2TimestampSchema = z.iso.datetime({ offset: true });
const OptionalText = (max: number) => z.string().min(1).max(max).nullable().optional();

// ---------------------------------------------------------------------------
// Records (POST v2/records)
// ---------------------------------------------------------------------------

/**
 * Repository a work unit or attempt belongs to: `vcs.repository.url.full`, with
 * credentials stripped. `null` when the checkout has no remote. Never a local path.
 */
const RepositoryUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((url) => !/^(?:\/|~|[A-Za-z]:[\\/]|file:)/.test(url), { message: 'repository url must not be a local path' })
  .nullable();

export const IngestV2WorkUnitLinkSchema = z.object({
  source: z.string().min(1).max(64),
  url: z.url(),
  label: OptionalText(256),
});

/** Key: (`repositoryUrl`, `workUnitId`). A work unit id is scoped to its repository. */
export const IngestV2WorkUnitRecordSchema = z.object({
  type: z.literal('WorkUnit'),
  workUnitId: IngestV2IdSchema,
  repositoryUrl: RepositoryUrlSchema,
  source: OptionalText(64),
  url: z.url().nullable().optional(),
  title: OptionalText(512),
  parentWorkUnitId: IngestV2IdSchema.nullable().optional(),
  links: z.array(IngestV2WorkUnitLinkSchema).default([]),
});

/** Key: `attemptId`. */
export const IngestV2AttemptRecordSchema = z.object({
  type: z.literal('Attempt'),
  attemptId: IngestV2IdSchema,
  /** `null` for a slot launched without a work unit. */
  workUnitId: IngestV2IdSchema.nullable(),
  repositoryUrl: RepositoryUrlSchema,
  slotId: IngestV2IdSchema,
  branch: z.string().min(1).max(256),
  baseCommit: GitObjectIdSchema,
  startedAt: IngestV2TimestampSchema,
  /** Set when the attempt is completed or torn down. */
  endedAt: IngestV2TimestampSchema.nullable().optional(),
});

/**
 * Key: (`agentTool`, `sessionId`, `from`). The segment as written in the session
 * context file (ADR 0004 section 2), plus its session and attempt.
 */
export const IngestV2SessionSegmentRecordSchema = z
  .object({
    type: z.literal('SessionSegment'),
    agentTool: SessionContextAgentToolSchema,
    sessionId: SessionContextSessionIdSchema,
    /** `attributes["factory.attempt.id"]`, lifted out for indexing. */
    attemptId: IngestV2IdSchema.nullable(),
    ...SESSION_SEGMENT_SHAPE,
  })
  .superRefine((record, ctx) => {
    if (!isSegmentIntervalValid(record)) {
      ctx.addIssue({ code: 'custom', message: 'segment `to` is before `from`', path: ['to'] });
    }
    if ((record.attributes[SESSION_CONTEXT_ATTEMPT_ATTR] ?? null) !== record.attemptId) {
      ctx.addIssue({
        code: 'custom',
        message: `attemptId must equal attributes["${SESSION_CONTEXT_ATTEMPT_ATTR}"]`,
        path: ['attemptId'],
      });
    }
  });

/** A session that worked on a factory run (ADR 0004 section 4, "Session refs"). */
export const IngestV2FactoryRunSessionRefSchema = z.object({
  agentTool: SessionContextAgentToolSchema,
  sessionId: SessionContextSessionIdSchema,
  from: IngestV2TimestampSchema,
  /** End of the overlap with the run window; `null` while the segment is still open. */
  to: IngestV2TimestampSchema.nullable(),
  ranVerify: z.boolean(),
});

/** Key: `factoryRunId` (the validation id: `Factory-Run`, `predicate.run.id`). */
export const IngestV2FactoryRunRecordSchema = z.object({
  type: z.literal('FactoryRun'),
  factoryRunId: IngestV2IdSchema,
  attemptId: IngestV2IdSchema.nullable(),
  /** The verified git tree (`factory.git.tree`, the statement subject's `gitTree`). */
  tree: GitObjectIdSchema,
  verdict: z.enum(INGEST_V2_VERDICTS),
  policy: z.object({
    id: IngestV2IdSchema,
    /** sha256 hex of the policy source (`.har/stages.json`). */
    digest: Sha256HexSchema.nullable().optional(),
    required: z.array(IngestV2IdSchema),
  }),
  factoryLine: IngestV2IdSchema.nullable().optional(),
  station: IngestV2IdSchema.nullable().optional(),
  /** `sha256("factory-run:" + factoryRunId)`, first 32 hex chars. */
  traceId: TraceIdSchema,
  startedAt: IngestV2TimestampSchema,
  finishedAt: IngestV2TimestampSchema,
  /** Merged, never replaced, when the same tree is verified again. */
  sessions: z.array(IngestV2FactoryRunSessionRefSchema).default([]),
  /** Stage ids in run order; each has a `StageResult` record. */
  stages: z.array(IngestV2IdSchema),
});

/** A file of evidence, listed by digest (`predicate.stages[].artifacts[]`). */
export const IngestV2EvidenceArtifactSchema = z.object({
  /** Name relative to the stage's artifact directory; never an absolute path. */
  name: z
    .string()
    .min(1)
    .max(512)
    .refine((name) => !/^(?:\/|~|[A-Za-z]:[\\/])/.test(name) && !name.split(/[\\/]/).includes('..'), {
      message: 'artifact name must be relative and must not contain ".."',
    }),
  sha256: Sha256HexSchema,
  size: z.number().int().nonnegative(),
  mediaType: z.string().min(1).max(256),
});

/** Key: (`factoryRunId`, `stageId`). */
export const IngestV2StageResultRecordSchema = z.object({
  type: z.literal('StageResult'),
  factoryRunId: IngestV2IdSchema,
  stageId: IngestV2IdSchema,
  status: z.enum(INGEST_V2_STAGE_STATUSES),
  addedBy: z.enum(INGEST_V2_STAGE_ADDED_BY),
  kind: z.string().min(1).max(64).nullable().optional(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** sha256 of the stage log as kept (the last 1 MiB), `null` when no log was kept. */
  logDigest: Sha256HexSchema.nullable(),
  artifacts: z.array(IngestV2EvidenceArtifactSchema).default([]),
});

/** Key: `commitSha`. */
export const IngestV2CommitBindingRecordSchema = z.object({
  type: z.literal('CommitBinding'),
  commitSha: GitObjectIdSchema,
  tree: GitObjectIdSchema,
  factoryRunId: IngestV2IdSchema,
  /** Statement digest of the proof for this tree, when one was written. */
  proofDigest: StatementDigestSchema.nullable(),
  branch: z.string().min(1).max(256).nullable(),
});

/** DSSE envelope (https://github.com/secure-systems-lab/dsse) of a Factory Commits statement. */
export const DsseEnvelopeSchema = z.object({
  payloadType: z.string().min(1),
  /** Standard base64 of the statement bytes. */
  payload: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  signatures: z.array(z.object({ keyid: z.string().optional(), sig: z.string() })),
});
export type DsseEnvelope = z.infer<typeof DsseEnvelopeSchema>;

/** Key: `statementDigest` (the receiver recomputes it from the payload). */
export const IngestV2AttestationRecordSchema = z.object({
  type: z.literal('Attestation'),
  statementDigest: StatementDigestSchema,
  envelope: DsseEnvelopeSchema,
  factoryRunId: IngestV2IdSchema,
  tree: GitObjectIdSchema,
  verdict: z.enum(INGEST_V2_VERDICTS),
  trust: z.enum(INGEST_V2_TRUST_LEVELS),
  /** Signer principal; `null` for an unsigned (L1) statement. */
  signer: z.string().min(1).max(512).nullable(),
});

/** Key: `sha256`. `location` is set by the receiver that stores the bytes, never by the CLI. */
export const IngestV2EvidenceBlobRecordSchema = z.object({
  type: z.literal('EvidenceBlob'),
  sha256: Sha256HexSchema,
  size: z.number().int().nonnegative(),
  mediaType: z.string().min(1).max(256),
  location: z.string().min(1).max(2048).nullable().optional(),
});

export const IngestV2RecordSchema = z.discriminatedUnion('type', [
  IngestV2WorkUnitRecordSchema,
  IngestV2AttemptRecordSchema,
  IngestV2SessionSegmentRecordSchema,
  IngestV2FactoryRunRecordSchema,
  IngestV2StageResultRecordSchema,
  IngestV2CommitBindingRecordSchema,
  IngestV2AttestationRecordSchema,
  IngestV2EvidenceBlobRecordSchema,
]);
export type IngestV2Record = z.infer<typeof IngestV2RecordSchema>;
export type IngestV2RecordOf<T extends IngestV2RecordType> = Extract<IngestV2Record, { type: T }>;

/** Body of `POST v2/records`. */
export const IngestV2RecordsBodySchema = z.object({
  records: z.array(IngestV2RecordSchema).min(1).max(INGEST_V2_MAX_RECORDS_PER_BATCH),
});
export type IngestV2RecordsBody = z.infer<typeof IngestV2RecordsBodySchema>;

/** Statuses a receiver answers for a body that does not parse with this contract's schemas. */
export const INGEST_V2_INVALID_BODY_STATUSES = [400, 422] as const;

export const INGEST_V2_WRITE_STATUSES = ['created', 'updated', 'unchanged'] as const;

/**
 * Reply to `POST v2/records` (2xx). `results` is optional; when present it has one
 * entry per record, in order. Sending the same batch again yields no `created`.
 */
export const IngestV2RecordsResponseSchema = z.object({
  results: z
    .array(
      z.object({
        type: z.enum(INGEST_V2_RECORD_TYPES),
        key: z.string(),
        status: z.enum(INGEST_V2_WRITE_STATUSES),
      }),
    )
    .optional(),
});
export type IngestV2RecordsResponse = z.infer<typeof IngestV2RecordsResponseSchema>;

/**
 * A record's natural key as one string: the JSON array of its key fields. Equal
 * keys mean the same record, so a receiver upserts on it.
 */
export function ingestV2RecordKey(record: IngestV2Record): string {
  switch (record.type) {
    case 'WorkUnit':
      return JSON.stringify([record.repositoryUrl, record.workUnitId]);
    case 'Attempt':
      return JSON.stringify([record.attemptId]);
    case 'SessionSegment':
      return JSON.stringify([record.agentTool, record.sessionId, new Date(record.from).toISOString()]);
    case 'FactoryRun':
      return JSON.stringify([record.factoryRunId]);
    case 'StageResult':
      return JSON.stringify([record.factoryRunId, record.stageId]);
    case 'CommitBinding':
      return JSON.stringify([record.commitSha]);
    case 'Attestation':
      return JSON.stringify([record.statementDigest]);
    case 'EvidenceBlob':
      return JSON.stringify([record.sha256]);
  }
}

// ---------------------------------------------------------------------------
// Proofs (POST v2/proofs)
// ---------------------------------------------------------------------------

/** Body of `POST v2/proofs`: DSSE envelopes of Factory Commits statements. */
export const IngestV2ProofsBodySchema = z.object({
  envelopes: z.array(DsseEnvelopeSchema).min(1).max(INGEST_V2_MAX_RECORDS_PER_BATCH),
});
export type IngestV2ProofsBody = z.infer<typeof IngestV2ProofsBodySchema>;

/** Reply to `POST v2/proofs`: the digest the receiver recomputed for each envelope, in order. */
export const IngestV2ProofsResponseSchema = z.object({
  results: z
    .array(z.object({ statementDigest: StatementDigestSchema, status: z.enum(INGEST_V2_WRITE_STATUSES) }))
    .optional(),
});
export type IngestV2ProofsResponse = z.infer<typeof IngestV2ProofsResponseSchema>;

// ---------------------------------------------------------------------------
// Evidence (POST v2/evidence/missing, PUT v2/evidence/{sha256})
// ---------------------------------------------------------------------------

export const IngestV2EvidenceMissingRequestSchema = z.object({
  digests: z.array(Sha256HexSchema).min(1).max(INGEST_V2_MAX_RECORDS_PER_BATCH),
});
export type IngestV2EvidenceMissingRequest = z.infer<typeof IngestV2EvidenceMissingRequestSchema>;

/**
 * The digests the receiver lacks, each with where to `PUT` the bytes: an absolute
 * URL, or a path relative to the ingest base URL (normally `v2/evidence/<sha256>`).
 */
export const IngestV2EvidenceMissingResponseSchema = z.object({
  missing: z.array(z.object({ sha256: Sha256HexSchema, uploadUrl: z.string().min(1) })),
});
export type IngestV2EvidenceMissingResponse = z.infer<typeof IngestV2EvidenceMissingResponseSchema>;

/**
 * `PUT v2/evidence/{sha256}` takes the raw bytes (`Content-Type` is the media
 * type). The receiver hashes them: 2xx when the digest matches (again: a no-op),
 * 4xx and nothing stored when it does not.
 */
export const INGEST_V2_EVIDENCE_DIGEST_MISMATCH_STATUSES = [400, 409, 422] as const;

// ---------------------------------------------------------------------------
// Capabilities (GET v2/capabilities)
// ---------------------------------------------------------------------------

export const IngestV2CapabilitiesSchema = z.looseObject({
  contractVersion: z.literal(INGEST_V2_CONTRACT_VERSION),
  /** OTLP signals accepted at `otel/v1/<signal>`. */
  signals: z.array(z.enum(INGEST_V2_SIGNALS)),
  /** Record types accepted by `POST v2/records`. */
  recordTypes: z.array(z.enum(INGEST_V2_RECORD_TYPES)),
  proofs: z.boolean(),
  evidence: z.boolean(),
  /** Largest evidence file accepted, in bytes; absent when there is no limit. */
  maxEvidenceBytes: z.number().int().positive().optional(),
});
export type IngestV2Capabilities = z.infer<typeof IngestV2CapabilitiesSchema>;
