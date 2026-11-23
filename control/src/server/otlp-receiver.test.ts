import { createRequire } from 'node:module';
import * as zlib from 'node:zlib';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ingest = vi.hoisted(() => ({
  traces: vi.fn(),
  metrics: vi.fn(),
  logs: vi.fn(),
  forward: vi.fn(),
}));

vi.mock('@/server/otel-ingest', () => ({
  ingestOtelTracesBody: ingest.traces,
  ingestOtelMetricsBody: ingest.metrics,
  ingestOtelLogsBody: ingest.logs,
}));
vi.mock('@/server/otlp-forward', () => ({ scheduleOtlpForwardBody: ingest.forward }));

import { handleOtlpHttpExport, partialSuccessErrorMessage, receiveOtlpExport } from './otlp-receiver';

type Codec = { decode: (bytes: Uint8Array) => unknown; toObject: (m: unknown, o?: object) => Record<string, unknown> };
const collector = (
  createRequire(__filename)('@opentelemetry/otlp-transformer/build/src/generated/root.js') as {
    opentelemetry: { proto: { collector: Record<string, { v1: Record<string, Codec> }> } };
  }
).opentelemetry.proto.collector;

const SIGNALS = [
  { signal: 'traces', pkg: 'trace', type: 'ExportTraceServiceResponse', field: 'rejectedSpans' },
  { signal: 'metrics', pkg: 'metrics', type: 'ExportMetricsServiceResponse', field: 'rejectedDataPoints' },
  { signal: 'logs', pkg: 'logs', type: 'ExportLogsServiceResponse', field: 'rejectedLogRecords' },
] as const;

const post = (signal: string, body: Buffer, headers: Record<string, string>) =>
  new Request(`http://localhost/api/otel/v1/${signal}`, { method: 'POST', body: new Uint8Array(body), headers });

describe('OTLP/HTTP export responses', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const { signal } of SIGNALS) {
      ingest[signal].mockResolvedValue({ accepted: 1, dropped: 2, reasons: ['no repository known for session s1'] });
    }
  });

  for (const { signal, pkg, type, field } of SIGNALS) {
    it(`${signal}: JSON request → JSON response with partialSuccess.${field}`, async () => {
      const response = await handleOtlpHttpExport(signal, post(signal, Buffer.from('{}'), { 'content-type': 'application/json' }));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      const json = (await response.json()) as { partialSuccess: Record<string, unknown>; har: unknown };
      expect(json.partialSuccess).toEqual({
        [field]: 2,
        errorMessage: '2 not stored by Mission Control: no repository known for session s1',
      });
      expect(json.partialSuccess).not.toHaveProperty(field === 'rejectedDataPoints' ? 'rejectedSpans' : 'rejectedDataPoints');
      // Mission Control's own diagnostic stays in JSON responses.
      expect(json.har).toEqual({ accepted: 1, dropped: 2, reasons: ['no repository known for session s1'] });
      expect(ingest.forward).toHaveBeenCalledWith(signal, Buffer.from('{}'), {
        contentType: 'application/json',
        contentEncoding: null,
      });
    });

    it(`${signal}: protobuf request → protobuf ${type}`, async () => {
      const body = Buffer.from([0x0a, 0x00]);
      const response = await handleOtlpHttpExport(signal, post(signal, body, { 'content-type': 'application/x-protobuf' }));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/x-protobuf');
      const Response = collector[pkg].v1[type];
      const decoded = Response.toObject(Response.decode(new Uint8Array(await response.arrayBuffer())), { longs: Number });
      expect(decoded.partialSuccess).toEqual({
        [field]: 2,
        errorMessage: '2 not stored by Mission Control: no repository known for session s1',
      });
      expect(ingest[signal]).toHaveBeenCalledWith(body, 'application/x-protobuf');
    });
  }

  it('leaves partialSuccess unset when everything was stored (spec: full success)', async () => {
    ingest.traces.mockResolvedValue({ accepted: 3, dropped: 0, reasons: [] });
    const json = await handleOtlpHttpExport('traces', post('traces', Buffer.from('{}'), { 'content-type': 'application/json' }));
    expect(await json.json()).not.toHaveProperty('partialSuccess');
    const proto = await handleOtlpHttpExport('traces', post('traces', Buffer.from([0x0a, 0x00]), { 'content-type': 'application/x-protobuf' }));
    expect((await proto.arrayBuffer()).byteLength).toBe(0);
  });

  it('reports reasons with nothing rejected as a warning (rejected 0 + errorMessage)', async () => {
    ingest.logs.mockResolvedValue({ accepted: 1, dropped: 0, reasons: ['ingest failed: database locked'] });
    const response = await handleOtlpHttpExport('logs', post('logs', Buffer.from('{}'), { 'content-type': 'application/json' }));
    expect(((await response.json()) as { partialSuccess: unknown }).partialSuccess).toEqual({
      rejectedLogRecords: 0,
      errorMessage: 'ingest failed: database locked',
    });
  });

  it('ingests a gzip body decoded and forwards the original bytes with their encoding', async () => {
    const plain = Buffer.from('{"resourceSpans":[]}');
    const gz = zlib.gzipSync(plain);
    ingest.traces.mockResolvedValue({ accepted: 0, dropped: 0, reasons: [] });
    await receiveOtlpExport('traces', { body: gz, contentType: 'application/json', contentEncoding: 'gzip' });
    expect(ingest.traces).toHaveBeenCalledWith(plain, 'application/json');
    expect(ingest.forward).toHaveBeenCalledWith('traces', gz, { contentType: 'application/json', contentEncoding: 'gzip' });
  });

  it('rejects an unknown content encoding and still hands it to the forwarder (which decides)', async () => {
    const result = await receiveOtlpExport('logs', { body: Buffer.from('x'), contentType: 'application/json', contentEncoding: 'zstd' });
    expect(result).toEqual({ accepted: 0, dropped: 1, reasons: ['unsupported content-encoding zstd'] });
    expect(ingest.logs).not.toHaveBeenCalled();
    expect(ingest.forward).toHaveBeenCalledTimes(1);
  });

  it('does not forward when ingest throws (as before)', async () => {
    ingest.metrics.mockRejectedValue(new Error('database is locked'));
    const result = await receiveOtlpExport('metrics', { body: Buffer.from('{}'), contentType: 'application/json' });
    expect(result).toEqual({ accepted: 0, dropped: 0, reasons: ['database is locked'] });
    expect(ingest.forward).not.toHaveBeenCalled();
  });

  it('keeps the error message short with many distinct reasons', () => {
    const reasons = Array.from({ length: 8 }, (_, i) => `reason ${i} ${'x'.repeat(80)}`);
    const message = partialSuccessErrorMessage({ accepted: 0, dropped: 8, reasons });
    expect(message?.length).toBeLessThanOrEqual(300);
    expect(message).toMatch(/^8 not stored by Mission Control: reason 0/);
  });
});
