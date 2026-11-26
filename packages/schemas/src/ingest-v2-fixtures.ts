import type { DsseEnvelope, IngestV2Record, IngestV2RecordOf } from './ingest-v2';

/**
 * Canonical ingest v2 fixtures: one coherent story that any receiver can load
 * and that the contract runner (`ingest-v2-contract.ts`) sends.
 *
 * Work unit `contract-1` → one attempt in slot 3 → one agent session segment →
 * two factory runs of that attempt (the first fails unit-tests, the second passes)
 * → their stage results → a commit of the passing tree → its attestation (an
 * unsigned DSSE envelope) → the evidence files the stage results list by digest.
 *
 * Every digest below is the real SHA-256 of the bytes given here (checked by the
 * schemas tests), so a receiver can verify uploads against them. Pure data, no
 * Node APIs: safe to import anywhere.
 */

export const INGEST_V2_FIXTURE_REPOSITORY_URL = 'https://github.com/example-org/example-repo';
export const INGEST_V2_FIXTURE_WORK_UNIT_ID = 'contract-1';
export const INGEST_V2_FIXTURE_ATTEMPT_ID = '7b0e7f8e-1f7a-4c39-9a51-0c2f3d6c9a01';
export const INGEST_V2_FIXTURE_SESSION_ID = 'fixture-session-0001';
export const INGEST_V2_FIXTURE_BRANCH = 'main-0c2f-har-agent-3-ab12';

/** Run ids and their trace ids: `sha256("factory-run:" + id)`, first 32 hex chars. */
export const INGEST_V2_FIXTURE_RUNS = {
  failing: { id: '01JD4X7Q', traceId: '08a4c2fcb06d20d6c9f76d79addde080', tree: '1111111111111111111111111111111111111111' },
  passing: { id: '01JD5A2M', traceId: '2cf404f3f55f190d30a07c0810bb6cff', tree: '2222222222222222222222222222222222222222' },
} as const;

export const INGEST_V2_FIXTURE_COMMIT_SHA = '3333333333333333333333333333333333333333';
const BASE_COMMIT = '0000000000000000000000000000000000000001';

/** A file of evidence: its bytes (UTF-8 text here), digest, size and media type. */
export interface IngestV2FixtureBlob {
  name: string;
  content: string;
  sha256: string;
  size: number;
  mediaType: string;
}

export const INGEST_V2_FIXTURE_BLOBS = {
  failingUnitTestsLog: {
    name: 'unit-tests.log',
    content: 'FAIL tests/cart.test.ts\n  expected total 42, received 41\nTests: 1 failed, 11 passed, 12 total\n',
    sha256: '2f31ab238e404ecf2ad30b57104f01dbdddcd53b484e62a232b6f05b4eb8fc58',
    size: 94,
    mediaType: 'text/plain; charset=utf-8',
  },
  passingUnitTestsLog: {
    name: 'unit-tests.log',
    content: 'PASS tests/cart.test.ts\nTests: 12 passed, 12 total\n',
    sha256: 'edf27094bc85f4f0f9b10a325f0b03cbdfd40cd7337624ff778bd254115e7376',
    size: 51,
    mediaType: 'text/plain; charset=utf-8',
  },
  passingReport: {
    name: 'unit-tests/report.json',
    content: '{"numTotalTests":12,"numPassedTests":12,"numFailedTests":0}\n',
    sha256: 'a80616c3695240b6a88a32c9f085cd7b2d9e00a22ec7280cc5cc353f45a91821',
    size: 60,
    mediaType: 'application/json',
  },
} satisfies Record<string, IngestV2FixtureBlob>;

/** A digest that matches none of the blobs (`sha256("ingest-v2 contract: wrong digest")`). */
export const INGEST_V2_FIXTURE_WRONG_SHA256 = '88b3cb5917114a20d119e331de87a4953285ed2dc4305c11d51e5a983a73da09';

/** The in-toto statement the fixture attestation signs (Factory Commits `factory-run`, unsigned). */
export const INGEST_V2_FIXTURE_STATEMENT = {
  _type: 'https://in-toto.io/Statement/v1',
  subject: [
    {
      name: `git+${INGEST_V2_FIXTURE_REPOSITORY_URL}`,
      digest: { gitTree: INGEST_V2_FIXTURE_RUNS.passing.tree },
    },
  ],
  predicateType: 'https://os-factory.dev/factory-commits/factory-run/v0.1',
  predicate: {
    run: {
      id: INGEST_V2_FIXTURE_RUNS.passing.id,
      startedOn: '2026-11-25T11:00:00.000Z',
      finishedOn: '2026-11-25T11:05:00.000Z',
    },
    workUnit: { id: INGEST_V2_FIXTURE_WORK_UNIT_ID, source: 'github', attemptId: INGEST_V2_FIXTURE_ATTEMPT_ID },
    policy: { id: 'har-verify-full', required: ['typecheck', 'unit-tests'] },
    stages: [
      { id: 'typecheck', status: 'passed', addedBy: 'policy', durationMs: 4100 },
      {
        id: 'unit-tests',
        status: 'passed',
        addedBy: 'policy',
        durationMs: 12000,
        artifacts: [
          { name: 'unit-tests.log', digest: { sha256: 'edf27094bc85f4f0f9b10a325f0b03cbdfd40cd7337624ff778bd254115e7376' } },
          { name: 'unit-tests/report.json', digest: { sha256: 'a80616c3695240b6a88a32c9f085cd7b2d9e00a22ec7280cc5cc353f45a91821' } },
        ],
      },
    ],
    verdict: 'pass',
    producer: { name: 'har', version: '2.0.0' },
    environment: { trust: 'self-reported', executor: 'local' },
    telemetry: { traceId: INGEST_V2_FIXTURE_RUNS.passing.traceId },
  },
} as const;

/** The payload bytes are `JSON.stringify(INGEST_V2_FIXTURE_STATEMENT)` (ASCII), as standard base64. */
export const INGEST_V2_FIXTURE_ENVELOPE: DsseEnvelope = {
  payloadType: 'application/vnd.in-toto+json',
  payload: btoa(JSON.stringify(INGEST_V2_FIXTURE_STATEMENT)),
  signatures: [],
};

/** `sha256:` + SHA-256 of the decoded payload bytes (Factory Commits statement digest). */
export const INGEST_V2_FIXTURE_STATEMENT_DIGEST = 'sha256:420b3ce7abe83145362985867af159234ce54e0934eae03910347b13b5445d82';

const SEGMENT_FROM = '2026-11-25T10:02:11.000Z';
const SEGMENT_TO = '2026-11-25T11:30:00.000Z';
const blobs = INGEST_V2_FIXTURE_BLOBS;
const runs = INGEST_V2_FIXTURE_RUNS;

function sessionRef(to: string): IngestV2RecordOf<'FactoryRun'>['sessions'][number] {
  return { agentTool: 'claude_code', sessionId: INGEST_V2_FIXTURE_SESSION_ID, from: SEGMENT_FROM, to, ranVerify: true };
}

function artifact(blob: IngestV2FixtureBlob) {
  return { name: blob.name, sha256: blob.sha256, size: blob.size, mediaType: blob.mediaType };
}

/**
 * The canonical records, in dependency order, as a fresh array (callers may
 * mutate it). Every record parses with `IngestV2RecordSchema`.
 */
export function ingestV2FixtureRecords(): IngestV2Record[] {
  const records: IngestV2Record[] = [
    {
      type: 'WorkUnit',
      workUnitId: INGEST_V2_FIXTURE_WORK_UNIT_ID,
      repositoryUrl: INGEST_V2_FIXTURE_REPOSITORY_URL,
      source: 'github',
      url: `${INGEST_V2_FIXTURE_REPOSITORY_URL}/issues/1`,
      title: 'Ingest v2 contract fixture',
      links: [{ source: 'github', url: `${INGEST_V2_FIXTURE_REPOSITORY_URL}/pull/2`, label: 'PR' }],
    },
    {
      type: 'Attempt',
      attemptId: INGEST_V2_FIXTURE_ATTEMPT_ID,
      workUnitId: INGEST_V2_FIXTURE_WORK_UNIT_ID,
      repositoryUrl: INGEST_V2_FIXTURE_REPOSITORY_URL,
      slotId: '3',
      branch: INGEST_V2_FIXTURE_BRANCH,
      baseCommit: BASE_COMMIT,
      startedAt: '2026-11-25T10:00:00.000Z',
      endedAt: null,
    },
    {
      type: 'SessionSegment',
      agentTool: 'claude_code',
      sessionId: INGEST_V2_FIXTURE_SESSION_ID,
      attemptId: INGEST_V2_FIXTURE_ATTEMPT_ID,
      from: SEGMENT_FROM,
      to: SEGMENT_TO,
      reason: 'launch',
      attributes: {
        'factory.work_unit.id': INGEST_V2_FIXTURE_WORK_UNIT_ID,
        'factory.work_unit.source': 'github',
        'factory.attempt.id': INGEST_V2_FIXTURE_ATTEMPT_ID,
        'factory.slot.id': '3',
        'vcs.repository.url.full': INGEST_V2_FIXTURE_REPOSITORY_URL,
        'vcs.ref.head.name': INGEST_V2_FIXTURE_BRANCH,
      },
    },
    {
      type: 'FactoryRun',
      factoryRunId: runs.failing.id,
      attemptId: INGEST_V2_FIXTURE_ATTEMPT_ID,
      tree: runs.failing.tree,
      verdict: 'fail',
      policy: { id: 'har-verify-full', required: ['typecheck', 'unit-tests'] },
      factoryLine: null,
      station: null,
      traceId: runs.failing.traceId,
      startedAt: '2026-11-25T10:30:00.000Z',
      finishedAt: '2026-11-25T10:34:00.000Z',
      sessions: [sessionRef('2026-11-25T10:34:00.000Z')],
      stages: ['typecheck', 'unit-tests'],
    },
    {
      type: 'StageResult',
      factoryRunId: runs.failing.id,
      stageId: 'typecheck',
      status: 'passed',
      addedBy: 'policy',
      durationMs: 4000,
      logDigest: null,
      artifacts: [],
    },
    {
      type: 'StageResult',
      factoryRunId: runs.failing.id,
      stageId: 'unit-tests',
      status: 'failed',
      addedBy: 'policy',
      durationMs: 11800,
      logDigest: blobs.failingUnitTestsLog.sha256,
      artifacts: [artifact(blobs.failingUnitTestsLog)],
    },
    {
      type: 'FactoryRun',
      factoryRunId: runs.passing.id,
      attemptId: INGEST_V2_FIXTURE_ATTEMPT_ID,
      tree: runs.passing.tree,
      verdict: 'pass',
      policy: { id: 'har-verify-full', required: ['typecheck', 'unit-tests'] },
      factoryLine: null,
      station: null,
      traceId: runs.passing.traceId,
      startedAt: '2026-11-25T11:00:00.000Z',
      finishedAt: '2026-11-25T11:05:00.000Z',
      sessions: [sessionRef('2026-11-25T11:05:00.000Z')],
      stages: ['typecheck', 'unit-tests'],
    },
    {
      type: 'StageResult',
      factoryRunId: runs.passing.id,
      stageId: 'typecheck',
      status: 'passed',
      addedBy: 'policy',
      durationMs: 4100,
      logDigest: null,
      artifacts: [],
    },
    {
      type: 'StageResult',
      factoryRunId: runs.passing.id,
      stageId: 'unit-tests',
      status: 'passed',
      addedBy: 'policy',
      durationMs: 12000,
      logDigest: blobs.passingUnitTestsLog.sha256,
      artifacts: [artifact(blobs.passingUnitTestsLog), artifact(blobs.passingReport)],
    },
    {
      type: 'CommitBinding',
      commitSha: INGEST_V2_FIXTURE_COMMIT_SHA,
      tree: runs.passing.tree,
      factoryRunId: runs.passing.id,
      proofDigest: INGEST_V2_FIXTURE_STATEMENT_DIGEST,
      branch: INGEST_V2_FIXTURE_BRANCH,
    },
    {
      type: 'Attestation',
      statementDigest: INGEST_V2_FIXTURE_STATEMENT_DIGEST,
      envelope: { ...INGEST_V2_FIXTURE_ENVELOPE, signatures: [] },
      factoryRunId: runs.passing.id,
      tree: runs.passing.tree,
      verdict: 'pass',
      trust: 'self-reported',
      signer: null,
    },
    ...Object.values(blobs).map(
      (blob): IngestV2Record => ({ type: 'EvidenceBlob', sha256: blob.sha256, size: blob.size, mediaType: blob.mediaType }),
    ),
  ];
  return records;
}
