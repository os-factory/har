import * as net from 'node:net';
import { createRequire } from 'node:module';
import * as grpc from '@grpc/grpc-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ingest = vi.hoisted(() => ({
  traces: vi.fn(),
  metrics: vi.fn(),
  logs: vi.fn(),
}));

vi.mock('@/server/otel-ingest', () => ({
  ingestOtelTracesBody: ingest.traces,
  ingestOtelMetricsBody: ingest.metrics,
  ingestOtelLogsBody: ingest.logs,
}));

import {
  createOtlpGrpcServer,
  otlpGrpcServiceDefinition,
  resolveOtlpGrpcPort,
  startOtlpGrpcServer,
} from './otlp-grpc';

type Codec = {
  encode: (m: unknown) => { finish: () => Uint8Array };
  decode: (bytes: Uint8Array) => unknown;
  toObject: (m: unknown, o?: object) => Record<string, unknown>;
};
const collector = (
  createRequire(__filename)('@opentelemetry/otlp-transformer/build/src/generated/root.js') as {
    opentelemetry: { proto: { collector: Record<string, { v1: Record<string, Codec> }> } };
  }
).opentelemetry.proto.collector;

const SIGNALS = [
  {
    signal: 'traces',
    pkg: 'trace',
    name: 'Trace',
    field: 'rejectedSpans',
    request: { resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'span-a' }] }] }] },
  },
  {
    signal: 'metrics',
    pkg: 'metrics',
    name: 'Metrics',
    field: 'rejectedDataPoints',
    request: { resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'metric-a' }] }] }] },
  },
  {
    signal: 'logs',
    pkg: 'logs',
    name: 'Logs',
    field: 'rejectedLogRecords',
    request: { resourceLogs: [{ scopeLogs: [{ logRecords: [{ severityText: 'INFO' }] }] }] },
  },
] as const;

function exportOverGrpc(port: number, signal: (typeof SIGNALS)[number]['signal'], body: Buffer): Promise<Buffer> {
  const Client = grpc.makeGenericClientConstructor(otlpGrpcServiceDefinition(signal), signal);
  const client = new Client(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), {
    // A stock Collector compresses with gzip by default.
    'grpc.default_compression_algorithm': grpc.compressionAlgorithms.gzip,
  });
  return new Promise((resolve, reject) => {
    (client as unknown as { Export: (b: Buffer, cb: (e: Error | null, r: Buffer) => void) => void }).Export(
      body,
      (err, response) => {
        client.close();
        if (err) reject(err);
        else resolve(response);
      },
    );
  });
}

describe('OTLP/gRPC receiver', () => {
  let server: grpc.Server;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = createOtlpGrpcServer();
    const bound = await startOtlpGrpcServer(server, 0, '127.0.0.1');
    expect(bound).not.toBeNull();
    port = bound as number;
  });

  afterEach(() => {
    server.forceShutdown();
  });

  for (const { signal, pkg, name, field, request } of SIGNALS) {
    it(`${name}Service/Export ingests and answers with partial_success`, async () => {
      ingest[signal].mockResolvedValue({ accepted: 0, dropped: 1, reasons: ['no repository known for session s1'] });
      const Request = collector[pkg].v1[`Export${name}ServiceRequest`];
      const body = Buffer.from(Request.encode(request).finish());

      const response = await exportOverGrpc(port, signal, body);

      // Same ingest function as OTLP/HTTP, given the protobuf bytes (gRPC compression removed).
      expect(ingest[signal]).toHaveBeenCalledTimes(1);
      expect(Buffer.compare(ingest[signal].mock.calls[0][0], body)).toBe(0);
      expect(ingest[signal].mock.calls[0][1]).toBe('application/x-protobuf');

      const Response = collector[pkg].v1[`Export${name}ServiceResponse`];
      expect(Response.toObject(Response.decode(response), { longs: Number })).toEqual({
        partialSuccess: { [field]: 1, errorMessage: '1 not stored by Mission Control: no repository known for session s1' },
      });
    });
  }

  it('logs one line and resolves null when the port is busy', async () => {
    const holder = net.createServer();
    await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const busyPort = (holder.address() as net.AddressInfo).port;
    const log = vi.fn();
    const second = createOtlpGrpcServer();
    try {
      await expect(startOtlpGrpcServer(second, busyPort, '127.0.0.1', log)).resolves.toBeNull();
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toContain(`port ${busyPort} is in use`);
      expect(log.mock.calls[0][0]).toContain('OTLP/HTTP still at /api/otel/v1/*');
    } finally {
      second.forceShutdown();
      holder.close();
    }
  });

  it('reads the port from HAR_CONTROL_OTLP_GRPC_PORT, 4317 by default, off disables', () => {
    expect(resolveOtlpGrpcPort({})).toBe(4317);
    expect(resolveOtlpGrpcPort({ HAR_CONTROL_OTLP_GRPC_PORT: '14317' })).toBe(14317);
    expect(resolveOtlpGrpcPort({ HAR_CONTROL_OTLP_GRPC_PORT: 'off' })).toBeNull();
    expect(resolveOtlpGrpcPort({ HAR_CONTROL_OTLP_GRPC_PORT: '0' })).toBeNull();
  });
});
