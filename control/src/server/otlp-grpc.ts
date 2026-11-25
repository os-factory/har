import * as net from 'node:net';
import * as grpc from '@grpc/grpc-js';
import type { OtlpSignal } from '@har/schemas';
import type { OtelIngestResult } from '@/server/otel-ingest';
import { encodeOtlpExportResponse, receiveOtlpExport, type OtlpExportRequest } from '@/server/otlp-receiver';

/**
 * OTLP/gRPC receiver: `opentelemetry.proto.collector.{trace,metrics,logs}.v1.
 * {Trace,Metrics,Logs}Service/Export`, the default transport of most OTel SDKs
 * and Collectors (port 4317).
 *
 * Messages stay raw protobuf bytes (grpc-js has already removed any gRPC
 * message compression): each Export request is exactly the body of an OTLP/HTTP
 * protobuf request, so it goes through the same `receiveOtlpExport` as the HTTP
 * routes. The response is the protobuf `Export*ServiceResponse` with
 * `partial_success`.
 */

export const OTLP_GRPC_DEFAULT_PORT = 4317;
/** Where clients reach the gRPC receiver: the listen port in dev, the host port `har control up` publishes. */
export const OTLP_GRPC_PORT_ENV = 'HAR_CONTROL_OTLP_GRPC_PORT';

const PROTOBUF = 'application/x-protobuf';

const SERVICES: Record<OtlpSignal, string> = {
  traces: 'opentelemetry.proto.collector.trace.v1.TraceService',
  metrics: 'opentelemetry.proto.collector.metrics.v1.MetricsService',
  logs: 'opentelemetry.proto.collector.logs.v1.LogsService',
};

const identity = (value: Buffer) => value;

/** Service definition with pass-through serializers: Mission Control decodes the bytes itself. */
export function otlpGrpcServiceDefinition(signal: OtlpSignal): grpc.ServiceDefinition {
  return {
    Export: {
      path: `/${SERVICES[signal]}/Export`,
      requestStream: false,
      responseStream: false,
      requestSerialize: identity,
      requestDeserialize: identity,
      responseSerialize: identity,
      responseDeserialize: identity,
      originalName: 'export',
    },
  };
}

export type OtlpReceive = (signal: OtlpSignal, request: OtlpExportRequest) => Promise<OtelIngestResult>;

/** A server with the three Export services; `receive` defaults to the shared receive path. */
export function createOtlpGrpcServer(receive: OtlpReceive = receiveOtlpExport): grpc.Server {
  const server = new grpc.Server({ 'grpc.max_receive_message_length': 16 * 1024 * 1024 });
  for (const signal of Object.keys(SERVICES) as OtlpSignal[]) {
    server.addService(otlpGrpcServiceDefinition(signal), {
      Export: (call: grpc.ServerUnaryCall<Buffer, Buffer>, callback: grpc.sendUnaryData<Buffer>) => {
        receive(signal, { body: call.request, contentType: PROTOBUF, contentEncoding: null })
          .then((result) => callback(null, encodeOtlpExportResponse(signal, result)))
          .catch((err: unknown) =>
            callback({ code: grpc.status.INTERNAL, details: err instanceof Error ? err.message : String(err) }),
          );
      },
    });
  }
  return server;
}

/** Port from `HAR_CONTROL_OTLP_GRPC_PORT`; null when set to 0/off/false (receiver disabled). */
export function resolveOtlpGrpcPort(env: Record<string, string | undefined> = process.env): number | null {
  const raw = env[OTLP_GRPC_PORT_ENV]?.trim().toLowerCase();
  if (!raw) return OTLP_GRPC_DEFAULT_PORT;
  if (raw === '0' || raw === 'off' || raw === 'false') return null;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : OTLP_GRPC_DEFAULT_PORT;
}

/**
 * Bind and start. Resolves to the bound port, or null when the port is busy or
 * the bind failed: one line is logged and OTLP/HTTP keeps working.
 */
export function startOtlpGrpcServer(
  server: grpc.Server,
  port: number,
  host = '0.0.0.0',
  log: (line: string) => void = console.warn,
): Promise<number | null> {
  const notStarted = (reason: string) =>
    log(`[otlp-grpc] ${reason}; OTLP/gRPC receiver not started (OTLP/HTTP still at /api/otel/v1/*)`);
  return new Promise((resolve) => {
    // Probe first: grpc-js would also print its own error for a busy port.
    const probe = net.createServer();
    probe.once('error', (err: NodeJS.ErrnoException) => {
      notStarted(err.code === 'EADDRINUSE' ? `port ${port} is in use` : err.message);
      resolve(null);
    });
    probe.listen(port, host, () => probe.close(() => void bind().then(resolve)));
  });

  function bind(): Promise<number | null> {
    return new Promise((resolve) => {
      server.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
        if (err) {
          notStarted(err.message);
          resolve(null);
          return;
        }
        resolve(boundPort);
      });
    });
  }
}

// One receiver per server process, surviving dev hot reloads.
const globalForGrpc = globalThis as unknown as { __harOtlpGrpc?: Promise<number | null> };

/** Start the receiver once per process (called from `instrumentation.ts`). */
export function startOtlpGrpcReceiver(env: Record<string, string | undefined> = process.env): Promise<number | null> {
  globalForGrpc.__harOtlpGrpc ??= (async () => {
    const port = resolveOtlpGrpcPort(env);
    if (port === null) return null;
    const bound = await startOtlpGrpcServer(createOtlpGrpcServer(), port);
    if (bound !== null) console.log(`[otlp-grpc] OTLP/gRPC receiver listening on :${bound}`);
    return bound;
  })().catch((err: unknown) => {
    console.warn(`[otlp-grpc] ${err instanceof Error ? err.message : String(err)}; OTLP/gRPC receiver not started`);
    return null;
  });
  return globalForGrpc.__harOtlpGrpc;
}
