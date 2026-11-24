import { createRequire } from 'node:module';
import * as zlib from 'node:zlib';
import { TELEMETRY_LOCAL_PATH_ATTRIBUTES, removeDeniedOtlpAttributes, type OtlpSignal } from '@har/schemas';

/**
 * Remove denied attributes from an OTLP/HTTP body before Mission Control
 * forwards a copy of it to a third-party destination: absolute local paths
 * (`TELEMETRY_LOCAL_PATH_ATTRIBUTES`, including every `factory.local.*` key)
 * and account identity
 * (`TELEMETRY_ACCOUNT_IDENTITY_ATTRIBUTES`), per `forwardDeniedAttributes`.
 *
 * Attributes are removed wherever OTLP carries them: resource, instrumentation
 * scope, span, span event, span link, log record, metric data point and
 * exemplar (`filteredAttributes`). Everything else is left as it was: a protobuf
 * body is decoded and re-encoded as protobuf with the same generated OTLP types
 * Mission Control ingests with, a JSON body is re-serialized as JSON, and the
 * original content encoding (gzip, deflate, br) is re-applied.
 *
 * When the body cannot contain a denied key, the original bytes are returned
 * untouched. When it may contain one but cannot be decoded, the result is
 * `null`: the caller must not forward it.
 */

export type OtlpBodyHeaders = { contentType: string; contentEncoding?: string };
export type StrippedOtlpBody = OtlpBodyHeaders & { body: Buffer; removed: number };

type ProtobufType = {
  decode: (data: Uint8Array) => unknown;
  encode: (message: unknown) => { finish: () => Uint8Array };
};

const nodeRequire = createRequire(__filename);

function protobufType(signal: OtlpSignal): ProtobufType | null {
  try {
    // Same generated root the OTLP receivers decode with (otel-ingest.ts).
    const root = nodeRequire('@opentelemetry/otlp-transformer/build/src/generated/root.js') as {
      opentelemetry?: { proto?: { collector?: Record<string, { v1?: Record<string, ProtobufType> } | undefined> } };
    };
    const collector = root.opentelemetry?.proto?.collector;
    const type =
      signal === 'traces'
        ? collector?.trace?.v1?.ExportTraceServiceRequest
        : signal === 'logs'
          ? collector?.logs?.v1?.ExportLogsServiceRequest
          : collector?.metrics?.v1?.ExportMetricsServiceRequest;
    return typeof type?.decode === 'function' && typeof type.encode === 'function' ? type : null;
  } catch {
    return null;
  }
}

type Codec = { decode: (body: Buffer) => Buffer; encode: (body: Buffer) => Buffer };

const CODECS: Record<string, Codec> = {
  identity: { decode: (b) => b, encode: (b) => b },
  gzip: { decode: (b) => zlib.gunzipSync(b), encode: (b) => zlib.gzipSync(b) },
  'x-gzip': { decode: (b) => zlib.gunzipSync(b), encode: (b) => zlib.gzipSync(b) },
  deflate: { decode: (b) => zlib.inflateSync(b), encode: (b) => zlib.deflateSync(b) },
  br: { decode: (b) => zlib.brotliDecompressSync(b), encode: (b) => zlib.brotliCompressSync(b) },
};

/** A denied key, or a `prefix.*` rule's prefix, appears in the bytes. */
function mentionsDeniedKey(body: Buffer, denied: readonly string[]): boolean {
  for (const entry of denied) {
    const needle = entry.endsWith('*') ? entry.slice(0, -1) : entry;
    if (body.includes(Buffer.from(needle, 'utf8'))) return true;
  }
  return false;
}

/** Filter every `attributes` / `filteredAttributes` list in place; returns how many entries were removed. */
export function removeDeniedAttributes(
  node: unknown,
  denied: readonly string[] = TELEMETRY_LOCAL_PATH_ATTRIBUTES,
): number {
  return removeDeniedOtlpAttributes(node, denied);
}

function isJson(contentType: string, body: Buffer): boolean {
  return contentType.toLowerCase().includes('json') || body[0] === 0x7b; // same rule as the receivers
}

/** Strip local path attributes only (`TELEMETRY_LOCAL_PATH_ATTRIBUTES`). */
export function stripLocalPathAttributes(
  signal: OtlpSignal,
  original: Buffer,
  headers: OtlpBodyHeaders,
): StrippedOtlpBody | null {
  return stripDeniedAttributes(signal, original, headers, TELEMETRY_LOCAL_PATH_ATTRIBUTES);
}

/** Strip the given attribute keys (`prefix.*` entries match a namespace); an empty list returns the original body. */
export function stripDeniedAttributes(
  signal: OtlpSignal,
  original: Buffer,
  headers: OtlpBodyHeaders,
  deniedKeys: readonly string[],
): StrippedOtlpBody | null {
  const denied = deniedKeys;
  const unchanged: StrippedOtlpBody = { ...headers, body: original, removed: 0 };
  if (denied.length === 0) return unchanged;
  const encoding = (headers.contentEncoding ?? 'identity').trim().toLowerCase() || 'identity';
  const codec = CODECS[encoding];
  // An encoding we cannot read may hide anything: do not forward it.
  if (!codec) return null;

  let plain: Buffer;
  try {
    plain = codec.decode(original);
  } catch {
    // The destination cannot decode it either, so it cannot read a path from it.
    return unchanged;
  }

  const json = isJson(headers.contentType, plain);
  // Protobuf strings are raw UTF-8, so a key absent from the bytes is absent
  // from the message. JSON may spell a key with escapes, so any backslash means parse.
  if (!mentionsDeniedKey(plain, denied) && !(json && plain.includes(0x5c /* \ */))) return unchanged;

  let rewritten: Buffer;
  let removed: number;
  if (json) {
    let payload: unknown;
    try {
      payload = JSON.parse(plain.toString('utf8'));
    } catch {
      return null;
    }
    removed = removeDeniedAttributes(payload, denied);
    if (removed === 0) return unchanged;
    rewritten = Buffer.from(JSON.stringify(payload), 'utf8');
  } else {
    const type = protobufType(signal);
    if (!type) return null;
    let message: unknown;
    try {
      message = type.decode(plain);
    } catch {
      return null;
    }
    removed = removeDeniedAttributes(message, denied);
    if (removed === 0) return unchanged;
    rewritten = Buffer.from(type.encode(message).finish());
  }
  return { ...headers, body: codec.encode(rewritten), removed };
}
