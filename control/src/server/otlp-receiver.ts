import { createRequire } from 'node:module';
import * as zlib from 'node:zlib';
import type { OtlpSignal } from '@har/schemas';
import {
  ingestOtelLogsBody,
  ingestOtelMetricsBody,
  ingestOtelTracesBody,
  type OtelIngestResult,
} from '@/server/otel-ingest';
import { scheduleOtlpForwardBody } from '@/server/otlp-forward';

/**
 * The one OTLP receive path shared by the OTLP/HTTP routes
 * (`/api/otel/v1/{traces,metrics,logs}`) and the OTLP/gRPC receiver
 * (`otlp-grpc.ts`): decode the content encoding, ingest what Mission Control
 * can attribute, schedule the forward copy, and build the spec's
 * `Export*ServiceResponse` (`partial_success`).
 */

export interface OtlpExportRequest {
  body: Buffer;
  contentType: string | null;
  contentEncoding?: string | null;
  /**
   * Store without forwarding: the sender already delivered this payload to the
   * destinations itself (a verification trace spooled while Mission Control was
   * down). Set from the `x-har-otlp-forward: skip` request header.
   */
  skipForward?: boolean;
}

/** OTLP partial_success field name of the rejected count, per signal. */
export const OTLP_REJECTED_FIELD = {
  traces: 'rejectedSpans',
  metrics: 'rejectedDataPoints',
  logs: 'rejectedLogRecords',
} as const satisfies Record<OtlpSignal, string>;

const INGEST: Record<OtlpSignal, (body: Buffer, contentType: string | null) => Promise<OtelIngestResult>> = {
  traces: ingestOtelTracesBody,
  metrics: ingestOtelMetricsBody,
  logs: ingestOtelLogsBody,
};

const DECOMPRESS: Record<string, (body: Buffer) => Buffer> = {
  identity: (body) => body,
  gzip: (body) => zlib.gunzipSync(body),
  'x-gzip': (body) => zlib.gunzipSync(body),
  deflate: (body) => zlib.inflateSync(body),
  br: (body) => zlib.brotliDecompressSync(body),
};

const LOG_PREFIX: Record<OtlpSignal, string> = {
  traces: '[otel-traces]',
  metrics: '[otel-ingest]',
  logs: '[otel-logs]',
};

/**
 * Ingest one Export request and schedule its forward copy (original bytes and
 * encoding). Never throws: an ingest failure is logged and reported as a result
 * with no rejected records, as the HTTP routes always did.
 */
export async function receiveOtlpExport(signal: OtlpSignal, request: OtlpExportRequest): Promise<OtelIngestResult> {
  try {
    const result = await ingestDecoded(signal, request);
    // Copy to configured OTLP destinations after the response; never affects it.
    // Sent even when Mission Control could not read it, as the routes always did.
    if (!request.skipForward) scheduleOtlpForwardBody(signal, request.body, {
      contentType: request.contentType,
      contentEncoding: request.contentEncoding ?? null,
    });
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX[signal], message);
    return { accepted: 0, dropped: 0, reasons: [message] };
  }
}

async function ingestDecoded(signal: OtlpSignal, request: OtlpExportRequest): Promise<OtelIngestResult> {
  const encoding = (request.contentEncoding ?? 'identity').trim().toLowerCase() || 'identity';
  const decompress = DECOMPRESS[encoding];
  if (!decompress) {
    return { accepted: 0, dropped: 1, reasons: [`unsupported content-encoding ${encoding}`] };
  }
  let plain: Buffer;
  try {
    plain = decompress(request.body);
  } catch (err) {
    return {
      accepted: 0,
      dropped: 1,
      reasons: [`${encoding} body could not be decoded: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
  return INGEST[signal](plain, request.contentType);
}

const MAX_ERROR_MESSAGE = 300;

/** Short reason for `partial_success.error_message`: distinct reasons, capped. */
export function partialSuccessErrorMessage(result: OtelIngestResult): string | undefined {
  if (result.reasons.length === 0) return undefined;
  const distinct = [...new Set(result.reasons)];
  const shown = distinct.slice(0, 3).join('; ');
  const more = distinct.length > 3 ? ` (+${distinct.length - 3} more)` : '';
  const head = result.dropped > 0 ? `${result.dropped} not stored by Mission Control: ` : '';
  const message = `${head}${shown}${more}`;
  return message.length > MAX_ERROR_MESSAGE ? `${message.slice(0, MAX_ERROR_MESSAGE - 1)}…` : message;
}

/**
 * `partial_success` as the OTLP JSON mapping spells it (lowerCamelCase), or
 * undefined on full success: the spec has the server leave it unset then. With
 * nothing rejected but reasons to report, it carries them as a warning.
 */
export function otlpPartialSuccess(
  signal: OtlpSignal,
  result: OtelIngestResult,
): Record<string, number | string> | undefined {
  const errorMessage = partialSuccessErrorMessage(result);
  if (result.dropped === 0 && !errorMessage) return undefined;
  return {
    [OTLP_REJECTED_FIELD[signal]]: result.dropped,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

type ResponseType = { encode: (message: unknown) => { finish: () => Uint8Array } };

const nodeRequire = createRequire(__filename);

function responseType(signal: OtlpSignal): ResponseType {
  // Same generated root the receivers decode requests with (otel-ingest.ts).
  const root = nodeRequire('@opentelemetry/otlp-transformer/build/src/generated/root.js') as {
    opentelemetry: { proto: { collector: Record<string, { v1: Record<string, ResponseType> }> } };
  };
  const collector = root.opentelemetry.proto.collector;
  if (signal === 'traces') return collector.trace.v1.ExportTraceServiceResponse;
  if (signal === 'metrics') return collector.metrics.v1.ExportMetricsServiceResponse;
  return collector.logs.v1.ExportLogsServiceResponse;
}

/** Protobuf `Export<Signal>ServiceResponse` for this result. */
export function encodeOtlpExportResponse(signal: OtlpSignal, result: OtelIngestResult): Buffer {
  const partialSuccess = otlpPartialSuccess(signal, result);
  return Buffer.from(responseType(signal).encode(partialSuccess ? { partialSuccess } : {}).finish());
}

/** The request is OTLP/JSON (else protobuf), by content type, then by the receivers' first-byte rule. */
export function isJsonOtlpRequest(contentType: string | null, body: Buffer): boolean {
  const ct = (contentType ?? '').toLowerCase();
  if (ct.includes('json')) return true;
  if (ct.includes('protobuf')) return false;
  return body[0] === 0x7b; /* { */
}

/**
 * OTLP/HTTP response: 200 with `Export*ServiceResponse` in the request's
 * encoding. JSON responses also carry Mission Control's own ingest diagnostic
 * under `har` (read by HAR's end-to-end tests); OTLP clients ignore it.
 */
export function otlpHttpResponse(signal: OtlpSignal, result: OtelIngestResult, request: OtlpExportRequest): Response {
  if (!isJsonOtlpRequest(request.contentType, request.body)) {
    return new Response(new Uint8Array(encodeOtlpExportResponse(signal, result)), {
      status: 200,
      headers: { 'content-type': 'application/x-protobuf' },
    });
  }
  return Response.json({ partialSuccess: otlpPartialSuccess(signal, result), har: result }, { status: 200 });
}

/** Route handler body shared by the three OTLP/HTTP routes. */
export async function handleOtlpHttpExport(signal: OtlpSignal, request: Request): Promise<Response> {
  let exportRequest: OtlpExportRequest;
  try {
    exportRequest = {
      body: Buffer.from(await request.arrayBuffer()),
      contentType: request.headers.get('content-type'),
      contentEncoding: request.headers.get('content-encoding'),
      skipForward: request.headers.get('x-har-otlp-forward')?.trim().toLowerCase() === 'skip',
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX[signal], message);
    const result: OtelIngestResult = { accepted: 0, dropped: 0, reasons: [message] };
    return Response.json({ partialSuccess: otlpPartialSuccess(signal, result), har: result });
  }
  const result = await receiveOtlpExport(signal, exportRequest);
  return otlpHttpResponse(signal, result, exportRequest);
}
