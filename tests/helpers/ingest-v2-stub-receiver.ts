import * as crypto from 'crypto';
import * as http from 'http';
import type { AddressInfo } from 'net';
import {
  INGEST_V2_CONTRACT_VERSION,
  INGEST_V2_PATHS,
  INGEST_V2_RECORD_TYPES,
  IngestV2EvidenceMissingRequestSchema,
  IngestV2ProofsBodySchema,
  IngestV2RecordsBodySchema,
  ingestV2RecordKey,
  type IngestV2Capabilities,
  type IngestV2Record,
} from '../../packages/schemas/src/index';

/**
 * A minimal in-process ingest v2 receiver: just enough of ADR 0005 to prove the
 * contract runner before a real receiver exists. Storage is in memory.
 * `faults` turn individual behaviours off to check that the runner notices.
 */
export interface StubReceiverFaults {
  /** Store a second copy of a record sent again (not idempotent). */
  duplicateRecords?: boolean;
  /** Store evidence without checking the digest. */
  acceptWrongDigest?: boolean;
  /** Answer capabilities with contract version 1. */
  wrongContractVersion?: boolean;
}

export interface StubReceiver {
  baseUrl: string;
  /** Copies stored per record key. */
  records: Map<string, IngestV2Record[]>;
  proofs: Map<string, unknown>;
  evidence: Map<string, Buffer>;
  requests: { method: string; path: string; headers: http.IncomingHttpHeaders }[];
  close: () => Promise<void>;
}

const PREFIX = '/ingest/';

function sha256(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

export async function startStubReceiver(
  options: { faults?: StubReceiverFaults; requireHeader?: [string, string] } = {},
): Promise<StubReceiver> {
  const faults = options.faults ?? {};
  const records = new Map<string, IngestV2Record[]>();
  const proofs = new Map<string, unknown>();
  const evidence = new Map<string, Buffer>();
  const requests: StubReceiver['requests'] = [];

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const path = (req.url ?? '').startsWith(PREFIX) ? (req.url ?? '').slice(PREFIX.length) : '';
      requests.push({ method: req.method ?? '', path, headers: req.headers });
      const send = (status: number, payload?: unknown) => {
        res.writeHead(status, payload === undefined ? {} : { 'content-type': 'application/json' });
        res.end(payload === undefined ? undefined : JSON.stringify(payload));
      };
      const json = (): unknown => {
        try {
          return JSON.parse(body.toString('utf8'));
        } catch {
          return undefined;
        }
      };

      if (options.requireHeader) {
        const [name, value] = options.requireHeader;
        if (req.headers[name.toLowerCase()] !== value) return send(401, { error: 'unauthorized' });
      }

      if (req.method === 'GET' && path === INGEST_V2_PATHS.capabilities) {
        const capabilities: IngestV2Capabilities = {
          contractVersion: INGEST_V2_CONTRACT_VERSION,
          signals: ['traces', 'logs'],
          recordTypes: [...INGEST_V2_RECORD_TYPES],
          proofs: true,
          evidence: true,
        };
        return send(200, faults.wrongContractVersion ? { ...capabilities, contractVersion: '1' } : capabilities);
      }

      if (req.method === 'POST' && path === INGEST_V2_PATHS.records) {
        const parsed = IngestV2RecordsBodySchema.safeParse(json());
        if (!parsed.success) return send(422, { error: parsed.error.issues[0]?.message });
        const results = parsed.data.records.map((record) => {
          const key = ingestV2RecordKey(record);
          const copies = records.get(key) ?? [];
          const same = copies.some((copy) => JSON.stringify(copy) === JSON.stringify(record));
          let status: 'created' | 'updated' | 'unchanged';
          if (!copies.length || faults.duplicateRecords) {
            copies.push(record);
            status = 'created';
          } else {
            copies[0] = record;
            status = same ? 'unchanged' : 'updated';
          }
          records.set(key, copies);
          return { type: record.type, key, status };
        });
        return send(200, { results });
      }

      if (req.method === 'POST' && path === INGEST_V2_PATHS.proofs) {
        const parsed = IngestV2ProofsBodySchema.safeParse(json());
        if (!parsed.success) return send(422, { error: parsed.error.issues[0]?.message });
        const results = parsed.data.envelopes.map((envelope) => {
          const statementDigest = `sha256:${sha256(Buffer.from(envelope.payload, 'base64'))}`;
          const status = proofs.has(statementDigest) ? ('unchanged' as const) : ('created' as const);
          proofs.set(statementDigest, envelope);
          return { statementDigest, status };
        });
        return send(200, { results });
      }

      if (req.method === 'POST' && path === INGEST_V2_PATHS.evidenceMissing) {
        const parsed = IngestV2EvidenceMissingRequestSchema.safeParse(json());
        if (!parsed.success) return send(422, { error: parsed.error.issues[0]?.message });
        const missing = [...new Set(parsed.data.digests)]
          .filter((digest) => !evidence.has(digest))
          .map((digest) => ({ sha256: digest, uploadUrl: `${INGEST_V2_PATHS.evidencePrefix}${digest}` }));
        return send(200, { missing });
      }

      if (req.method === 'PUT' && path.startsWith(INGEST_V2_PATHS.evidencePrefix)) {
        const digest = path.slice(INGEST_V2_PATHS.evidencePrefix.length);
        if (!/^[0-9a-f]{64}$/.test(digest)) return send(400, { error: 'bad digest' });
        if (!faults.acceptWrongDigest && sha256(body) !== digest) return send(422, { error: 'digest mismatch' });
        const existed = evidence.has(digest);
        evidence.set(digest, body);
        return send(existed ? 200 : 201);
      }

      return send(404, { error: 'not found' });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}${PREFIX.replace(/\/$/, '')}`,
    records,
    proofs,
    evidence,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
