import { createRequire } from 'node:module';
import * as zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { TELEMETRY_LOCAL_PATH_ATTRIBUTES } from '@har/schemas';
import { stripLocalPathAttributes } from './otlp-privacy';

type PbType = {
  fromObject: (value: unknown) => unknown;
  encode: (message: unknown) => { finish: () => Uint8Array };
  decode: (data: Uint8Array) => unknown;
  toObject: (message: unknown, options?: Record<string, unknown>) => Record<string, unknown>;
};
const root = createRequire(__filename)('@opentelemetry/otlp-transformer/build/src/generated/root.js') as {
  opentelemetry: { proto: { collector: Record<string, { v1: Record<string, PbType> }> } };
};
const collector = root.opentelemetry.proto.collector;
const TYPES = {
  traces: collector.trace.v1.ExportTraceServiceRequest,
  logs: collector.logs.v1.ExportLogsServiceRequest,
  metrics: collector.metrics.v1.ExportMetricsServiceRequest,
} as const;
const TO_OBJECT = { longs: String, enums: Number, bytes: String, arrays: true };

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const local = () => [str('har.repo_path', '/home/me/repo'), str('har.work_dir', '/home/me/worktrees/x')];
const kept = (prefix: string) => [str(`${prefix}.kept`, 'yes'), { key: `${prefix}.n`, value: { intValue: 7 } }];
const attrs = (prefix: string) => [...kept(prefix), ...local()];

const TRACE_ID = '5b8efff798038103d269b633813fc60c';
const SPAN_ID = 'eee19b7ec3c1b174';

/** One request per signal with local paths at every attribute level OTLP has. */
function request(signal: 'traces' | 'logs' | 'metrics', ids: 'hex' | 'base64') {
  const id = (hex: string) => (ids === 'hex' ? hex : Buffer.from(hex, 'hex').toString('base64'));
  const resource = { attributes: [...attrs('res'), str('service.name', 'har')] };
  const scope = { name: 'har', version: '2.0.0', attributes: attrs('scope') };
  if (signal === 'traces') {
    return {
      resourceSpans: [
        {
          resource,
          scopeSpans: [
            {
              scope,
              spans: [
                {
                  traceId: id(TRACE_ID),
                  spanId: id(SPAN_ID),
                  name: 'har.verify',
                  kind: 1,
                  startTimeUnixNano: '1700000000000000000',
                  endTimeUnixNano: '1700000001000000000',
                  attributes: attrs('span'),
                  events: [{ name: 'e', timeUnixNano: '1700000000500000000', attributes: attrs('event') }],
                  links: [{ traceId: id(TRACE_ID), spanId: id(SPAN_ID), attributes: attrs('link') }],
                  status: { code: 1 },
                },
              ],
            },
          ],
        },
      ],
    };
  }
  if (signal === 'logs') {
    return {
      resourceLogs: [
        {
          resource,
          scopeLogs: [
            {
              scope,
              logRecords: [
                {
                  timeUnixNano: '1700000000000000000',
                  severityNumber: 9,
                  body: { stringValue: 'tool ran' },
                  attributes: attrs('log'),
                  traceId: id(TRACE_ID),
                  spanId: id(SPAN_ID),
                },
              ],
            },
          ],
        },
      ],
    };
  }
  return {
    resourceMetrics: [
      {
        resource,
        scopeMetrics: [
          {
            scope,
            metrics: [
              {
                name: 'har.tokens',
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      asInt: '42',
                      timeUnixNano: '1700000000000000000',
                      attributes: attrs('point'),
                      exemplars: [{ asDouble: 1.5, timeUnixNano: '1700000000000000000', filteredAttributes: attrs('exemplar') }],
                    },
                  ],
                },
              },
              {
                name: 'har.duration',
                histogram: {
                  aggregationTemporality: 2,
                  dataPoints: [{ count: '1', sum: 2, bucketCounts: ['1'], explicitBounds: [], attributes: attrs('hist') }],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

/** Reference result: the same request with denied keys dropped by a plain deep copy. */
function withoutLocalPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutLocalPaths);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([field, child]) => [
      field,
      (field === 'attributes' || field === 'filteredAttributes') && Array.isArray(child)
        ? child.filter((kv: { key: string }) => !(TELEMETRY_LOCAL_PATH_ATTRIBUTES as readonly string[]).includes(kv.key)).map(withoutLocalPaths)
        : withoutLocalPaths(child),
    ]),
  );
}

const SIGNALS = ['traces', 'logs', 'metrics'] as const;
const encodePb = (signal: (typeof SIGNALS)[number], value: unknown) =>
  Buffer.from(TYPES[signal].encode(TYPES[signal].fromObject(value)).finish());
const decodePb = (signal: (typeof SIGNALS)[number], body: Buffer) =>
  TYPES[signal].toObject(TYPES[signal].decode(body), TO_OBJECT);

describe('stripLocalPathAttributes', () => {
  for (const signal of SIGNALS) {
    it(`removes local paths from a protobuf ${signal} body at every level and keeps the rest`, () => {
      const original = encodePb(signal, request(signal, 'base64'));
      const out = stripLocalPathAttributes(signal, original, { contentType: 'application/x-protobuf' });
      expect(out).not.toBeNull();
      expect(out!.contentType).toBe('application/x-protobuf');
      expect(out!.removed).toBeGreaterThan(0);
      for (const key of TELEMETRY_LOCAL_PATH_ATTRIBUTES) expect(out!.body.includes(key)).toBe(false);
      expect(out!.body.includes('/home/me')).toBe(false);
      expect(decodePb(signal, out!.body)).toEqual(withoutLocalPaths(decodePb(signal, original)));
    });

    it(`removes local paths from a JSON ${signal} body at every level and keeps the rest`, () => {
      const payload = request(signal, 'hex');
      const original = Buffer.from(JSON.stringify(payload));
      const out = stripLocalPathAttributes(signal, original, { contentType: 'application/json' });
      expect(out!.contentType).toBe('application/json');
      expect(out!.body.toString()).not.toContain('/home/me');
      expect(JSON.parse(out!.body.toString())).toEqual(withoutLocalPaths(payload));
    });

    it(`forwards the original ${signal} bytes when no denied key is present`, () => {
      const clean = withoutLocalPaths(request(signal, 'base64'));
      const pb = encodePb(signal, clean);
      expect(stripLocalPathAttributes(signal, pb, { contentType: 'application/x-protobuf' })!.body).toBe(pb);
      const json = Buffer.from(JSON.stringify(withoutLocalPaths(request(signal, 'hex'))));
      expect(stripLocalPathAttributes(signal, json, { contentType: 'application/json' })!.body).toBe(json);
    });
  }

  it('strips gzip bodies and re-compresses them', () => {
    const original = zlib.gzipSync(encodePb('traces', request('traces', 'base64')));
    const out = stripLocalPathAttributes('traces', original, { contentType: 'application/x-protobuf', contentEncoding: 'gzip' })!;
    expect(out.contentEncoding).toBe('gzip');
    const plain = zlib.gunzipSync(out.body);
    expect(plain.includes('har.repo_path')).toBe(false);
    expect(decodePb('traces', plain)).toEqual(withoutLocalPaths(decodePb('traces', zlib.gunzipSync(original))));
  });

  it('catches keys spelled with JSON escapes', () => {
    const body = Buffer.from(
      '{"resourceLogs":[{"resource":{"attributes":[{"key":"har.repo\\u005fpath","value":{"stringValue":"/home/me/repo"}}]},"scopeLogs":[]}]}',
    );
    const out = stripLocalPathAttributes('logs', body, { contentType: 'application/json' })!;
    expect(out.removed).toBe(1);
    expect(out.body.toString()).not.toContain('/home/me');
  });

  it('refuses a body it cannot check', () => {
    const pb = encodePb('traces', request('traces', 'base64'));
    expect(stripLocalPathAttributes('traces', pb, { contentType: 'application/x-protobuf', contentEncoding: 'zstd' })).toBeNull();
    expect(stripLocalPathAttributes('logs', Buffer.from('{"har.repo_path": oops'), { contentType: 'application/json' })).toBeNull();
    const corrupt = Buffer.concat([Buffer.from([0x0a, 0xff, 0xff, 0xff, 0x0f]), Buffer.from('har.work_dir')]);
    expect(stripLocalPathAttributes('traces', corrupt, { contentType: 'application/x-protobuf' })).toBeNull();
  });
});
