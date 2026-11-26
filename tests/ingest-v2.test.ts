import { execFile, execFileSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { verificationTraceId } from '../src/core/proof';
import {
  INGEST_V2_CONTRACT_CHECKS,
  INGEST_V2_CONTRACT_VERSION,
  INGEST_V2_FIXTURE_BLOBS,
  INGEST_V2_FIXTURE_ENVELOPE,
  INGEST_V2_FIXTURE_RUNS,
  INGEST_V2_FIXTURE_STATEMENT_DIGEST,
  INGEST_V2_FIXTURE_WRONG_SHA256,
  INGEST_V2_RECORD_TYPES,
  IngestV2CapabilitiesSchema,
  IngestV2RecordSchema,
  IngestV2RecordsBodySchema,
  ingestV2EvidencePath,
  ingestV2FixtureRecords,
  ingestV2RecordKey,
  runIngestV2Contract,
  type IngestV2Record,
} from '../packages/schemas/src/index';
import { ingestV2ContractCliMain } from '../packages/schemas/src/ingest-v2-contract-cli';
import { startStubReceiver, type StubReceiver } from './helpers/ingest-v2-stub-receiver';

const sha256 = (bytes: string | Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

describe('ingest v2 schemas (ADR 0005)', () => {
  it('pins the contract version and the record types', () => {
    expect(INGEST_V2_CONTRACT_VERSION).toBe('2');
    expect(INGEST_V2_RECORD_TYPES).toEqual([
      'WorkUnit',
      'Attempt',
      'SessionSegment',
      'FactoryRun',
      'StageResult',
      'CommitBinding',
      'Attestation',
      'EvidenceBlob',
    ]);
    expect(ingestV2EvidencePath('a'.repeat(64))).toBe(`v2/evidence/${'a'.repeat(64)}`);
    expect(() => ingestV2EvidencePath('../x')).toThrow();
  });

  it('rejects unknown types, mismatched attempt ids and local paths', () => {
    const records = ingestV2FixtureRecords();
    const find = <T extends IngestV2Record['type']>(type: T) =>
      structuredClone(records.find((r) => r.type === type)) as Extract<IngestV2Record, { type: T }>;

    expect(IngestV2RecordSchema.safeParse({ type: 'Run', id: '1' }).success).toBe(false);

    const segment = find('SessionSegment');
    segment.attemptId = 'another';
    expect(IngestV2RecordSchema.safeParse(segment).success).toBe(false);
    const localSegment = find('SessionSegment');
    localSegment.attributes['factory.local.work_dir'] = '/home/me/wt';
    expect(IngestV2RecordSchema.safeParse(localSegment).success).toBe(false);

    const workUnit = find('WorkUnit');
    expect(IngestV2RecordSchema.safeParse({ ...workUnit, repositoryUrl: '/home/me/repo' }).success).toBe(false);
    expect(IngestV2RecordSchema.safeParse({ ...workUnit, repositoryUrl: null }).success).toBe(true);
    expect(IngestV2RecordSchema.safeParse({ ...workUnit, workUnitId: 'has space' }).success).toBe(false);

    const stage = find('StageResult');
    stage.artifacts = [{ name: '/abs/report.json', sha256: 'a'.repeat(64), size: 1, mediaType: 'application/json' }];
    expect(IngestV2RecordSchema.safeParse(stage).success).toBe(false);
    stage.artifacts = [{ name: '../report.json', sha256: 'a'.repeat(64), size: 1, mediaType: 'application/json' }];
    expect(IngestV2RecordSchema.safeParse(stage).success).toBe(false);

    const run = find('FactoryRun');
    expect(IngestV2RecordSchema.safeParse({ ...run, traceId: 'XYZ' }).success).toBe(false);

    expect(IngestV2RecordsBodySchema.safeParse({ records: [] }).success).toBe(false);
  });

  it('strips unknown fields so a newer producer can add optional ones', () => {
    const [workUnit] = ingestV2FixtureRecords();
    const parsed = IngestV2RecordSchema.parse({ ...workUnit, futureField: 1 });
    expect(parsed).not.toHaveProperty('futureField');
    expect(IngestV2CapabilitiesSchema.parse({
      contractVersion: '2',
      signals: [],
      recordTypes: [],
      proofs: true,
      evidence: false,
      extra: 'kept',
    })).toHaveProperty('extra', 'kept');
  });
});

describe('ingest v2 canonical fixtures', () => {
  const records = ingestV2FixtureRecords();

  it('parse, cover every record type, and have unique keys', () => {
    for (const record of records) expect(IngestV2RecordSchema.parse(record)).toEqual(record);
    expect(new Set(records.map((r) => r.type))).toEqual(new Set(INGEST_V2_RECORD_TYPES));
    const keys = records.map((r) => `${r.type} ${ingestV2RecordKey(r)}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('carry real digests, sizes and trace ids', () => {
    for (const blob of Object.values(INGEST_V2_FIXTURE_BLOBS)) {
      expect(blob.sha256).toBe(sha256(blob.content));
      expect(blob.size).toBe(Buffer.byteLength(blob.content));
    }
    expect(INGEST_V2_FIXTURE_WRONG_SHA256).toBe(sha256('ingest-v2 contract: wrong digest'));
    for (const run of Object.values(INGEST_V2_FIXTURE_RUNS)) expect(run.traceId).toBe(verificationTraceId(run.id));
    const payload = Buffer.from(INGEST_V2_FIXTURE_ENVELOPE.payload, 'base64');
    expect(INGEST_V2_FIXTURE_STATEMENT_DIGEST).toBe(`sha256:${sha256(payload)}`);
  });

  it('tell one coherent story', () => {
    const of = <T extends IngestV2Record['type']>(type: T) =>
      records.filter((r): r is Extract<IngestV2Record, { type: T }> => r.type === type);
    const [workUnit] = of('WorkUnit');
    const [attempt] = of('Attempt');
    expect(attempt.workUnitId).toBe(workUnit.workUnitId);
    expect(of('SessionSegment')[0].attemptId).toBe(attempt.attemptId);
    const runs = of('FactoryRun');
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.verdict)).toEqual(['fail', 'pass']);
    for (const run of runs) {
      expect(run.attemptId).toBe(attempt.attemptId);
      const stages = of('StageResult').filter((s) => s.factoryRunId === run.factoryRunId);
      expect(stages.map((s) => s.stageId)).toEqual(run.stages);
    }
    const [binding] = of('CommitBinding');
    const [attestation] = of('Attestation');
    expect(binding.factoryRunId).toBe(INGEST_V2_FIXTURE_RUNS.passing.id);
    expect(binding.proofDigest).toBe(attestation.statementDigest);
    expect(attestation.tree).toBe(binding.tree);
    const blobDigests = new Set(of('EvidenceBlob').map((b) => b.sha256));
    for (const stage of of('StageResult')) {
      if (stage.logDigest) expect(blobDigests.has(stage.logDigest)).toBe(true);
      for (const a of stage.artifacts) expect(blobDigests.has(a.sha256)).toBe(true);
    }
  });
});

describe('ingest v2 contract runner', () => {
  let receiver: StubReceiver | undefined;
  afterEach(async () => {
    await receiver?.close();
    receiver = undefined;
  });

  it('passes every check against a conforming receiver, twice in a row', async () => {
    receiver = await startStubReceiver({ requireHeader: ['x-ingest-key', 'secret'] });
    const stub = receiver;
    const countRecords = async (record: IngestV2Record) => stub.records.get(ingestV2RecordKey(record))?.length ?? 0;

    const first = await runIngestV2Contract({ baseUrl: stub.baseUrl, headers: { 'x-ingest-key': 'secret' }, countRecords });
    expect(first.map((r) => r.check)).toEqual([...INGEST_V2_CONTRACT_CHECKS]);
    expect(first.filter((r) => !r.pass)).toEqual([]);
    expect(first.find((r) => r.check === 'evidence: missing digests listed')?.detail).toBe('3 of 3 missing');
    expect(stub.proofs.has(INGEST_V2_FIXTURE_STATEMENT_DIGEST)).toBe(true);
    expect(stub.evidence.has(INGEST_V2_FIXTURE_WRONG_SHA256)).toBe(false);

    const again = await runIngestV2Contract({ baseUrl: `${stub.baseUrl}/`, headers: { 'x-ingest-key': 'secret' }, countRecords });
    expect(again.filter((r) => !r.pass)).toEqual([]);
  });

  it('skips the read-back without countRecords', async () => {
    receiver = await startStubReceiver();
    const results = await runIngestV2Contract({ baseUrl: receiver.baseUrl });
    expect(results.find((r) => r.check === 'records: no duplicates')).toMatchObject({ pass: true, skipped: true });
    expect(results.filter((r) => !r.pass)).toEqual([]);
  });

  it('fails the checks a faulty receiver breaks', async () => {
    receiver = await startStubReceiver({ faults: { duplicateRecords: true, acceptWrongDigest: true, wrongContractVersion: true } });
    const stub = receiver;
    const results = await runIngestV2Contract({
      baseUrl: stub.baseUrl,
      countRecords: async (record) => stub.records.get(ingestV2RecordKey(record))?.length ?? 0,
    });
    const failed = results.filter((r) => !r.pass).map((r) => r.check);
    expect(failed).toEqual([
      'capabilities',
      'records: idempotent',
      'records: no duplicates',
      'evidence: wrong digest rejected',
    ]);
  });

  it('reports an unreachable or unauthorized receiver as failures, never throws', async () => {
    receiver = await startStubReceiver({ requireHeader: ['authorization', 'Bearer k'] });
    const unauthorized = await runIngestV2Contract({ baseUrl: receiver.baseUrl });
    expect(unauthorized.filter((r) => r.pass && !r.skipped)).toEqual([]);

    const down = await runIngestV2Contract({
      baseUrl: 'http://127.0.0.1:9/ingest',
      fetch: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    expect(down.find((r) => r.check === 'capabilities')).toMatchObject({ pass: false, detail: expect.stringContaining('ECONNREFUSED') });
  });
});

describe('ingest v2 contract CLI', () => {
  let receiver: StubReceiver | undefined;
  afterEach(async () => {
    await receiver?.close();
    receiver = undefined;
  });

  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  }

  it('prints one line per check and exits 0 on a conforming receiver', async () => {
    receiver = await startStubReceiver({ requireHeader: ['x-ingest-key', 'a:b'] });
    const run = io();
    const code = await ingestV2ContractCliMain([receiver.baseUrl, '--header', 'x-ingest-key: a:b'], run.io);
    expect(code).toBe(0);
    const lines = run.out.join('\n').split('\n');
    expect(lines.filter((l) => /^(PASS|SKIP) {2}/.test(l))).toHaveLength(INGEST_V2_CONTRACT_CHECKS.length);
    expect(lines.at(-1)).toBe(`all ${INGEST_V2_CONTRACT_CHECKS.length} checks passed`);
  });

  it('exits 1 when a check fails and 2 on usage errors', async () => {
    receiver = await startStubReceiver({ faults: { acceptWrongDigest: true } });
    const failing = io();
    expect(await ingestV2ContractCliMain([receiver.baseUrl], failing.io)).toBe(1);
    expect(failing.out.join('\n')).toMatch(/^FAIL {2}evidence: wrong digest rejected/m);

    for (const argv of [[], ['not a url'], [receiver.baseUrl, '--header', 'novalue'], [receiver.baseUrl, '--bogus']]) {
      expect(await ingestV2ContractCliMain(argv, io().io)).toBe(2);
    }
  });

  it('runs as the built dist entry point', async () => {
    const pkg = path.resolve(__dirname, '..', 'packages', 'schemas');
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(pkg, 'tsconfig.build.json')], {
      stdio: 'pipe',
    });
    const cli = path.join(pkg, 'dist', 'ingest-v2-contract-cli.js');
    expect(fs.readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node')).toBe(true);

    receiver = await startStubReceiver();
    const baseUrl = receiver.baseUrl;
    const result = await new Promise<{ code: number | null; stdout: string }>((resolve) => {
      const child = execFile(process.execPath, [cli, baseUrl], (error, stdout) =>
        resolve({ code: error ? (error.code as number) : 0, stdout }),
      );
      child.stdin?.end();
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^PASS {2}capabilities/m);
  }, 60_000);
});
