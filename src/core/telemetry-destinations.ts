import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HAR_DESTINATIONS_DIR_ENV,
  OTLP_SIGNALS,
  TELEMETRY_DESTINATIONS_FILE,
  emptyTelemetryDestinationsFile,
  maskHeaderValue,
  otlpSignalUrl,
  telemetryDestinationSchema,
  telemetryDestinationsFileSchema,
  type OtlpDestinationProtocol,
  type OtlpSignal,
  type TelemetryDestination,
  type TelemetryDestinationsFile,
} from '../harness/schema';

/**
 * Machine-level OTLP destinations (`har telemetry destination …`).
 *
 * The file lives in its own directory so Mission Control's container can mount
 * the directory read-only: a single-file bind mount would pin the old inode and
 * miss every atomic rewrite below.
 */

export const DEFAULT_LANGFUSE_HOST = 'https://cloud.langfuse.com';

export function getDestinationsDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[HAR_DESTINATIONS_DIR_ENV];
  if (override && override.trim()) return path.resolve(override);
  return path.join(os.homedir(), '.har', 'destinations');
}

export function getTelemetryDestinationsPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(getDestinationsDir(env), TELEMETRY_DESTINATIONS_FILE);
}

/** Create the destinations directory (0700) — also before Mission Control mounts it. */
export function ensureDestinationsDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = getDestinationsDir(env);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Read the destinations file. Missing → empty. Invalid → throws (never silently drops a user's config). */
export function readTelemetryDestinations(env: NodeJS.ProcessEnv = process.env): TelemetryDestinationsFile {
  const filePath = getTelemetryDestinationsPath(env);
  if (!fs.existsSync(filePath)) return emptyTelemetryDestinationsFile();
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
  const parsed = telemetryDestinationsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${filePath}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  }
  return parsed.data;
}

/** Atomic write with mode 0600 (header values are secrets). */
export function writeTelemetryDestinations(
  file: TelemetryDestinationsFile,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const validated = telemetryDestinationsFileSchema.parse(file);
  ensureDestinationsDir(env);
  const filePath = getTelemetryDestinationsPath(env);
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmpPath, 0o600);
  fs.renameSync(tmpPath, filePath);
  return filePath;
}

export function addTelemetryDestination(
  destination: TelemetryDestination,
  options: { replace?: boolean; env?: NodeJS.ProcessEnv } = {},
): { path: string; replaced: boolean } {
  const env = options.env ?? process.env;
  const validated = telemetryDestinationSchema.parse(destination);
  const file = readTelemetryDestinations(env);
  const index = file.destinations.findIndex((entry) => entry.name === validated.name);
  if (index >= 0 && !options.replace) {
    throw new Error(`Destination "${validated.name}" already exists — pass --overwrite to replace it`);
  }
  const destinations = [...file.destinations];
  if (index >= 0) destinations[index] = validated;
  else destinations.push(validated);
  return { path: writeTelemetryDestinations({ ...file, destinations }, env), replaced: index >= 0 };
}

export function removeTelemetryDestination(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = readTelemetryDestinations(env);
  const destinations = file.destinations.filter((entry) => entry.name !== name);
  if (destinations.length === file.destinations.length) return false;
  writeTelemetryDestinations({ ...file, destinations }, env);
  return true;
}

export function findTelemetryDestination(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): TelemetryDestination | undefined {
  return readTelemetryDestinations(env).destinations.find((entry) => entry.name === name);
}

/** Parse repeated `--header K=V` flags. */
export function parseHeaderPairs(pairs: readonly string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    if (equals <= 0) throw new Error('--header expects Name=value');
    headers[pair.slice(0, equals).trim()] = pair.slice(equals + 1);
  }
  return headers;
}

/** Parse `--signals traces,logs` (also accepts repeated flags). */
export function parseSignals(values: readonly string[] | undefined): OtlpSignal[] | undefined {
  if (!values || values.length === 0) return undefined;
  const signals = values.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  for (const signal of signals) {
    if (!(OTLP_SIGNALS as readonly string[]).includes(signal)) {
      throw new Error(`Unknown signal "${signal}" (expected ${OTLP_SIGNALS.join(', ')})`);
    }
  }
  return [...new Set(signals)] as OtlpSignal[];
}

export function buildOtlpDestination(options: {
  name: string;
  endpoint: string;
  headers?: Record<string, string>;
  signals?: OtlpSignal[];
  protocol?: OtlpDestinationProtocol;
  enabled?: boolean;
}): TelemetryDestination {
  return telemetryDestinationSchema.parse({
    name: options.name,
    preset: 'otlp',
    endpoint: options.endpoint,
    protocol: options.protocol ?? 'http/protobuf',
    headers: options.headers ?? {},
    signals: options.signals ?? [...OTLP_SIGNALS],
    enabled: options.enabled ?? true,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Langfuse's OTLP endpoint: `<host>/api/public/otel`, HTTP only, Basic auth
 * with `public:secret`, and traces only (it ingests no OTLP logs or metrics).
 */
export function buildLangfuseDestination(options: {
  name: string;
  host?: string;
  publicKey: string;
  secretKey: string;
  protocol?: OtlpDestinationProtocol;
  enabled?: boolean;
}): TelemetryDestination {
  if (!options.publicKey || !options.secretKey) {
    throw new Error('Langfuse needs --public-key and --secret-key (or LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY)');
  }
  const host = (options.host ?? DEFAULT_LANGFUSE_HOST).replace(/\/+$/, '');
  const token = Buffer.from(`${options.publicKey}:${options.secretKey}`).toString('base64');
  return telemetryDestinationSchema.parse({
    name: options.name,
    preset: 'langfuse',
    endpoint: `${host}/api/public/otel`,
    protocol: options.protocol ?? 'http/protobuf',
    headers: { Authorization: `Basic ${token}` },
    signals: ['traces'],
    enabled: options.enabled ?? true,
    createdAt: new Date().toISOString(),
  });
}

/** A destination safe to print: header values masked. */
export function maskTelemetryDestination(destination: TelemetryDestination): TelemetryDestination {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(destination.headers)) headers[name] = maskHeaderValue(value);
  return { ...destination, headers };
}

function hex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

/** One small OTLP/JSON payload for the destination's first subscribed signal. */
export function buildTestPayload(signal: OtlpSignal, now = Date.now()): Record<string, unknown> {
  const nanos = (ms: number) => `${BigInt(ms) * 1_000_000n}`;
  const resource = {
    attributes: [{ key: 'service.name', value: { stringValue: 'har' } }],
  };
  const scope = { name: 'har.telemetry.destination-test' };
  const attributes = [{ key: 'har.destination_test', value: { boolValue: true } }];
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
                  traceId: hex(16),
                  spanId: hex(8),
                  name: 'har telemetry destination test',
                  kind: 1,
                  startTimeUnixNano: nanos(now - 1),
                  endTimeUnixNano: nanos(now),
                  attributes,
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
                  timeUnixNano: nanos(now),
                  severityNumber: 9,
                  severityText: 'INFO',
                  body: { stringValue: 'har telemetry destination test' },
                  attributes,
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
                name: 'har.destination_test',
                gauge: { dataPoints: [{ timeUnixNano: nanos(now), asInt: '1', attributes }] },
              },
            ],
          },
        ],
      },
    ],
  };
}

export interface DestinationTestResult {
  name: string;
  signal: OtlpSignal;
  url: string;
  ok: boolean;
  status: number | null;
  /** Never contains header values. */
  detail?: string;
}

/** Send one OTLP/JSON test record and report the HTTP status. */
export async function testTelemetryDestination(
  destination: TelemetryDestination,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<DestinationTestResult> {
  const signal = destination.signals.includes('traces') ? 'traces' : destination.signals[0];
  const url = otlpSignalUrl(destination.endpoint, signal);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { ...destination.headers, 'content-type': 'application/json' },
      body: JSON.stringify(buildTestPayload(signal)),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    let detail: string | undefined;
    if (!response.ok) {
      const text = (await response.text().catch(() => '')).trim();
      detail = text ? text.slice(0, 300) : response.statusText || undefined;
    }
    return { name: destination.name, signal, url, ok: response.ok, status: response.status, detail };
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    // undici reports "fetch failed" and keeps the reason (ECONNREFUSED, DNS, TLS) in `cause`.
    const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
    if (cause instanceof Error && cause.message) message = `${message}: ${cause.message}`;
    return { name: destination.name, signal, url, ok: false, status: null, detail: message };
  }
}
