import {
  INGEST_V2_CONTRACT_VERSION,
  INGEST_V2_EVIDENCE_DIGEST_MISMATCH_STATUSES,
  INGEST_V2_INVALID_BODY_STATUSES,
  INGEST_V2_PATHS,
  INGEST_V2_RECORD_TYPES,
  IngestV2CapabilitiesSchema,
  IngestV2EvidenceMissingResponseSchema,
  IngestV2ProofsResponseSchema,
  IngestV2RecordsResponseSchema,
  ingestV2EvidencePath,
  type IngestV2Record,
} from './ingest-v2';
import {
  INGEST_V2_FIXTURE_BLOBS,
  INGEST_V2_FIXTURE_ENVELOPE,
  INGEST_V2_FIXTURE_STATEMENT_DIGEST,
  INGEST_V2_FIXTURE_WRONG_SHA256,
  ingestV2FixtureRecords,
  type IngestV2FixtureBlob,
} from './ingest-v2-fixtures';

/**
 * HTTP contract tests for an ingest v2 receiver (ADR 0005). Any receiver can run
 * them against itself: Mission Control in its tests, a hosted receiver in CI.
 * They send the canonical fixtures (`ingest-v2-fixtures.ts`), so they are safe
 * to run again and again against the same receiver (every write is idempotent).
 *
 * Read APIs differ between receivers, so the "no duplicates" read-back is only
 * run when the caller passes `countRecords`.
 */

export interface IngestV2ContractCheck {
  check: string;
  pass: boolean;
  /** True when the check could not run (reported, never a failure). */
  skipped?: boolean;
  detail: string;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface RunIngestV2ContractOptions {
  /** The receiver's ingest base URL (Mission Control: `http://localhost:3847/api`). */
  baseUrl: string;
  /** Sent with every request (for example an ingest key). */
  headers?: Record<string, string>;
  fetch?: FetchLike;
  /** Optional read-back: how many copies of `record` the receiver now holds. */
  countRecords?: (record: IngestV2Record) => Promise<number>;
}

/** Ordered names of the checks, so a report can show which ones did not run. */
export const INGEST_V2_CONTRACT_CHECKS = [
  'capabilities',
  'records: accepted',
  'records: idempotent',
  'records: no duplicates',
  'records: invalid batch rejected',
  'proofs: accepted',
  'proofs: idempotent',
  'evidence: missing digests listed',
  'evidence: upload',
  'evidence: uploaded digest no longer missing',
  'evidence: wrong digest rejected',
] as const;

function resolveUrl(baseUrl: string, pathOrUrl: string): string {
  return new URL(pathOrUrl, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function summarize(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text === undefined ? '(empty body)' : text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function is2xx(status: number): boolean {
  return status >= 200 && status < 300;
}

function isOneOf(status: number, statuses: readonly number[]): boolean {
  return statuses.includes(status);
}

/** Run every contract check against one receiver. Never throws: a failed request is a failed check. */
export async function runIngestV2Contract(options: RunIngestV2ContractOptions): Promise<IngestV2ContractCheck[]> {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const results: IngestV2ContractCheck[] = [];
  const url = (path: string) => resolveUrl(options.baseUrl, path);
  const jsonHeaders = { ...options.headers, 'content-type': 'application/json' };

  async function check(name: string, body: () => Promise<Omit<IngestV2ContractCheck, 'check'>>): Promise<void> {
    try {
      results.push({ check: name, ...(await body()) });
    } catch (err) {
      results.push({ check: name, pass: false, detail: `request failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  const postJson = (path: string, payload: unknown) =>
    doFetch(url(path), { method: 'POST', headers: jsonHeaders, body: JSON.stringify(payload) });
  const putBlob = (target: string, blob: Pick<IngestV2FixtureBlob, 'content' | 'mediaType'>) =>
    doFetch(resolveUrl(options.baseUrl, target), {
      method: 'PUT',
      headers: { ...options.headers, 'content-type': blob.mediaType },
      body: new TextEncoder().encode(blob.content),
    });

  // capabilities
  await check('capabilities', async () => {
    const response = await doFetch(url(INGEST_V2_PATHS.capabilities), { headers: { ...options.headers } });
    const body = await readJson(response);
    if (response.status !== 200) return { pass: false, detail: `GET ${INGEST_V2_PATHS.capabilities} → ${response.status}` };
    const parsed = IngestV2CapabilitiesSchema.safeParse(body);
    if (!parsed.success) return { pass: false, detail: `not a v${INGEST_V2_CONTRACT_VERSION} capabilities body: ${summarize(body)}` };
    const missing = INGEST_V2_RECORD_TYPES.filter((type) => !parsed.data.recordTypes.includes(type));
    if (missing.length) return { pass: false, detail: `record types not supported: ${missing.join(', ')}` };
    if (!parsed.data.proofs || !parsed.data.evidence) return { pass: false, detail: 'proofs and evidence must both be supported' };
    return { pass: true, detail: `contract ${parsed.data.contractVersion}, signals: ${parsed.data.signals.join(', ') || 'none'}` };
  });

  // records
  const records = ingestV2FixtureRecords();
  await check('records: accepted', async () => {
    const response = await postJson(INGEST_V2_PATHS.records, { records });
    const body = await readJson(response);
    if (!is2xx(response.status)) return { pass: false, detail: `POST ${INGEST_V2_PATHS.records} → ${response.status}: ${summarize(body)}` };
    if (body === undefined) return { pass: true, detail: `${response.status}, ${records.length} records` };
    const parsed = IngestV2RecordsResponseSchema.safeParse(body);
    if (!parsed.success) return { pass: false, detail: `reply is not a records response: ${summarize(body)}` };
    if (parsed.data.results && parsed.data.results.length !== records.length) {
      return { pass: false, detail: `${parsed.data.results.length} results for ${records.length} records` };
    }
    return { pass: true, detail: `${response.status}, ${records.length} records` };
  });

  await check('records: idempotent', async () => {
    const response = await postJson(INGEST_V2_PATHS.records, { records });
    const body = await readJson(response);
    if (!is2xx(response.status)) return { pass: false, detail: `second POST → ${response.status}: ${summarize(body)}` };
    const parsed = IngestV2RecordsResponseSchema.safeParse(body ?? {});
    const created = parsed.success ? (parsed.data.results ?? []).filter((r) => r.status === 'created') : [];
    if (created.length) return { pass: false, detail: `second POST created ${created.map((r) => `${r.type} ${r.key}`).join(', ')}` };
    return { pass: true, detail: `${response.status}, nothing created` };
  });

  await check('records: no duplicates', async () => {
    if (!options.countRecords) return { pass: true, skipped: true, detail: 'skipped: no read-back (pass countRecords)' };
    const duplicated: string[] = [];
    for (const record of records) {
      const count = await options.countRecords(record);
      if (count !== 1) duplicated.push(`${record.type} ×${count}`);
    }
    return duplicated.length
      ? { pass: false, detail: `expected one copy each: ${duplicated.join(', ')}` }
      : { pass: true, detail: `${records.length} records, one copy each` };
  });

  await check('records: invalid batch rejected', async () => {
    const response = await postJson(INGEST_V2_PATHS.records, { records: [{ type: 'NotARecord', id: 'x' }] });
    await response.text();
    return isOneOf(response.status, INGEST_V2_INVALID_BODY_STATUSES)
      ? { pass: true, detail: `${response.status}` }
      : {
          pass: false,
          detail: `an unknown record type → ${response.status}, expected ${INGEST_V2_INVALID_BODY_STATUSES.join(' or ')}`,
        };
  });

  // proofs
  for (const name of ['proofs: accepted', 'proofs: idempotent'] as const) {
    await check(name, async () => {
      const response = await postJson(INGEST_V2_PATHS.proofs, { envelopes: [INGEST_V2_FIXTURE_ENVELOPE] });
      const body = await readJson(response);
      if (!is2xx(response.status)) return { pass: false, detail: `POST ${INGEST_V2_PATHS.proofs} → ${response.status}: ${summarize(body)}` };
      if (body === undefined) return { pass: true, detail: `${response.status}` };
      const parsed = IngestV2ProofsResponseSchema.safeParse(body);
      if (!parsed.success) return { pass: false, detail: `reply is not a proofs response: ${summarize(body)}` };
      const result = parsed.data.results?.[0];
      if (result && result.statementDigest !== INGEST_V2_FIXTURE_STATEMENT_DIGEST) {
        return { pass: false, detail: `receiver computed ${result.statementDigest}, expected ${INGEST_V2_FIXTURE_STATEMENT_DIGEST}` };
      }
      if (name === 'proofs: idempotent' && result?.status === 'created') return { pass: false, detail: 'second POST created the proof again' };
      return { pass: true, detail: `${response.status}${result ? `, ${result.status}` : ''}` };
    });
  }

  // evidence
  const blobs = Object.values(INGEST_V2_FIXTURE_BLOBS);
  const askMissing = async (digests: string[]) => {
    const response = await postJson(INGEST_V2_PATHS.evidenceMissing, { digests });
    const body = await readJson(response);
    if (response.status !== 200) throw new Error(`POST ${INGEST_V2_PATHS.evidenceMissing} → ${response.status}: ${summarize(body)}`);
    const parsed = IngestV2EvidenceMissingResponseSchema.safeParse(body);
    if (!parsed.success) throw new Error(`reply is not an evidence/missing response: ${summarize(body)}`);
    return parsed.data.missing;
  };

  let uploadTarget: { blob: IngestV2FixtureBlob; uploadUrl: string } | undefined;
  await check('evidence: missing digests listed', async () => {
    const asked = blobs.map((blob) => blob.sha256);
    const missing = await askMissing(asked);
    const stray = missing.filter((entry) => !asked.includes(entry.sha256));
    if (stray.length) return { pass: false, detail: `listed digests it was not asked about: ${stray.map((e) => e.sha256).join(', ')}` };
    // Upload a missing blob when there is one; on a receiver that already has them all, re-upload the first.
    const first = missing[0];
    const blob = first ? blobs.find((b) => b.sha256 === first.sha256) : blobs[0];
    if (blob) uploadTarget = { blob, uploadUrl: first ? first.uploadUrl : ingestV2EvidencePath(blob.sha256) };
    return { pass: true, detail: `${missing.length} of ${asked.length} missing` };
  });

  await check('evidence: upload', async () => {
    if (!uploadTarget) return { pass: false, detail: 'no digest to upload (evidence/missing failed)' };
    const response = await putBlob(uploadTarget.uploadUrl, uploadTarget.blob);
    const body = await readJson(response);
    return is2xx(response.status)
      ? { pass: true, detail: `${response.status}, ${uploadTarget.blob.sha256.slice(0, 12)}… (${uploadTarget.blob.size} bytes)` }
      : { pass: false, detail: `PUT ${uploadTarget.uploadUrl} → ${response.status}: ${summarize(body)}` };
  });

  await check('evidence: uploaded digest no longer missing', async () => {
    if (!uploadTarget) return { pass: false, detail: 'nothing was uploaded' };
    const missing = await askMissing([uploadTarget.blob.sha256]);
    return missing.length
      ? { pass: false, detail: `${uploadTarget.blob.sha256} still listed as missing after upload` }
      : { pass: true, detail: 'not listed' };
  });

  await check('evidence: wrong digest rejected', async () => {
    const response = await putBlob(ingestV2EvidencePath(INGEST_V2_FIXTURE_WRONG_SHA256), blobs[0]);
    await response.text();
    if (!isOneOf(response.status, INGEST_V2_EVIDENCE_DIGEST_MISMATCH_STATUSES)) {
      return {
        pass: false,
        detail: `bytes that do not match the digest → ${response.status}, expected ${INGEST_V2_EVIDENCE_DIGEST_MISMATCH_STATUSES.join(', ')}`,
      };
    }
    const missing = await askMissing([INGEST_V2_FIXTURE_WRONG_SHA256]);
    return missing.length === 1
      ? { pass: true, detail: `${response.status}, nothing stored` }
      : { pass: false, detail: `${response.status}, but the receiver now reports that digest as stored` };
  });

  return results;
}

/** One line per check: `PASS|FAIL|SKIP  <check>  <detail>`. */
export function formatIngestV2ContractReport(results: readonly IngestV2ContractCheck[]): string {
  return results
    .map((r) => `${r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'}  ${r.check}  ${r.detail}`)
    .join('\n');
}
