/**
 * Minimal OTLP/JSON trace encoder (OTLP/HTTP, `application/json`).
 *
 * Shape: `resourceSpans → scopeSpans → spans`, lowercase hex ids, times as
 * unix-nanosecond decimal strings, typed attribute values. Enough to send a
 * handful of spans without pulling in an OpenTelemetry SDK.
 */

export type OtlpAttributeInput = string | number | boolean | undefined;

export type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number };

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

/** `SpanKind` enum values from the OTLP proto. */
export const OTLP_SPAN_KIND = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 } as const;

/** `Status.StatusCode` enum values from the OTLP proto. */
export const OTLP_STATUS_CODE = { unset: 0, ok: 1, error: 2 } as const;

export interface OtlpSpanInput {
  /** 32 lowercase hex characters. */
  traceId: string;
  /** 16 lowercase hex characters. */
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind?: number;
  startTimeMs: number;
  endTimeMs: number;
  attributes?: Record<string, OtlpAttributeInput>;
  statusCode?: number;
}

export interface OtlpTracesInput {
  resource: Record<string, OtlpAttributeInput>;
  scope: { name: string; version?: string };
  spans: OtlpSpanInput[];
}

/** Milliseconds since the epoch → unix nanoseconds as a decimal string. */
export function unixNanoString(ms: number): string {
  return (BigInt(Math.round(ms)) * 1_000_000n).toString();
}

function encodeValue(value: string | number | boolean): OtlpAnyValue {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value };
  }
  return { stringValue: value };
}

/** Typed key/values. `undefined` and empty strings are omitted, never sent empty. */
export function encodeOtlpAttributes(attributes: Record<string, OtlpAttributeInput>): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (typeof value === 'number' && !Number.isFinite(value)) continue;
    out.push({ key, value: encodeValue(value) });
  }
  return out;
}

export function encodeOtlpTraces(input: OtlpTracesInput): Record<string, unknown> {
  return {
    resourceSpans: [
      {
        resource: { attributes: encodeOtlpAttributes(input.resource) },
        scopeSpans: [
          {
            scope: input.scope.version
              ? { name: input.scope.name, version: input.scope.version }
              : { name: input.scope.name },
            spans: input.spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
              name: span.name,
              kind: span.kind ?? OTLP_SPAN_KIND.internal,
              startTimeUnixNano: unixNanoString(span.startTimeMs),
              endTimeUnixNano: unixNanoString(Math.max(span.startTimeMs, span.endTimeMs)),
              attributes: encodeOtlpAttributes(span.attributes ?? {}),
              status: { code: span.statusCode ?? OTLP_STATUS_CODE.unset },
            })),
          },
        ],
      },
    ],
  };
}
