import type { AgentTrajectoryContentDisclosure } from '@har/schemas';

export const DEFAULT_TRAJECTORY_MAX_PAYLOAD_BYTES = 65_536;

const SECRET_LEAF =
  /^(authorization|api[_-]?key|password|passwd|secret|cookie|set-cookie|private[_-]?key|access[_-]?token|refresh[_-]?token|x-api-key|bearer)$/i;

export interface TrajectoryPolicy {
  maxPayloadBytes: number;
  retentionDays: number;
}

export function parseEnvInt(value: string | undefined, fallback: number, min = 0): number {
  if (value == null || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.floor(parsed));
}

export function trajectoryPolicy(
  env: Record<string, string | undefined> = process.env,
): TrajectoryPolicy {
  return {
    maxPayloadBytes: parseEnvInt(
      env.HAR_TRAJECTORY_MAX_PAYLOAD_BYTES,
      DEFAULT_TRAJECTORY_MAX_PAYLOAD_BYTES,
      1_024,
    ),
    retentionDays: parseEnvInt(env.HAR_TRAJECTORY_RETENTION_DAYS, 0, 0),
  };
}

export function isSecretAttributeKey(key: string): boolean {
  const leaf = key.split('.').pop() ?? key;
  return SECRET_LEAF.test(leaf);
}

export function redactSecretAttributes(
  attributes: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attributes)) {
    out[key] = isSecretAttributeKey(key) ? '[redacted]' : value;
  }
  return out;
}

export function isBinaryBody(value: unknown): boolean {
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) return true;
  if (value instanceof Uint8Array) return true;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as { bytes?: unknown; type?: unknown };
    if (record.bytes instanceof Uint8Array) return true;
    if (typeof record.type === 'string' && record.type.toLowerCase().startsWith('application/octet')) {
      return true;
    }
  }
  return typeof value === 'string' && value.includes('\u0000');
}

export function payloadByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8');
}

function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return value;
  return `${buffer.subarray(0, Math.max(0, maxBytes - 3)).toString('utf8')}…`;
}

function truncateUnknown(value: unknown, maxBytes: number): unknown {
  if (typeof value === 'string') return truncateUtf8(value, maxBytes);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as { stringValue?: unknown };
    if (typeof record.stringValue === 'string') {
      return { ...record, stringValue: truncateUtf8(record.stringValue, maxBytes) };
    }
  }
  const serialized = JSON.stringify(value) ?? 'null';
  if (Buffer.byteLength(serialized, 'utf8') <= maxBytes) return value;
  return truncateUtf8(serialized, maxBytes);
}

export function hidesTrajectoryContent(
  disclosure: AgentTrajectoryContentDisclosure | string,
): boolean {
  return disclosure === 'withheld' || disclosure === 'metadata_only';
}

export interface BoundTrajectoryPayload {
  payload: Record<string, unknown>;
  contentDisclosure: AgentTrajectoryContentDisclosure;
}

/**
 * Drop withheld/binary bodies, redact secret attributes, and cap stored JSON.
 * Disclosure is upgraded to truncated/metadata_only when content is removed.
 */
export function boundTrajectoryPayload(
  payload: Record<string, unknown>,
  disclosure: AgentTrajectoryContentDisclosure,
  maxPayloadBytes = DEFAULT_TRAJECTORY_MAX_PAYLOAD_BYTES,
): BoundTrajectoryPayload {
  const attributes = payload.attributes && typeof payload.attributes === 'object' && !Array.isArray(payload.attributes)
    ? redactSecretAttributes(payload.attributes as Record<string, unknown>)
    : payload.attributes;

  let next: Record<string, unknown> = { ...payload, attributes };
  let nextDisclosure = disclosure;

  if (hidesTrajectoryContent(nextDisclosure)) {
    next = { ...next, body: null, promptText: null, responseText: null, raw: null };
  } else if (isBinaryBody(next.body)) {
    next = { ...next, body: null, binaryOmitted: true };
    nextDisclosure = 'metadata_only';
  }

  if (payloadByteLength(next) > maxPayloadBytes) {
    const budget = Math.max(256, Math.floor(maxPayloadBytes / 3));
    next = {
      ...next,
      body: next.body == null ? null : truncateUnknown(next.body, budget),
      promptText: typeof next.promptText === 'string' ? truncateUtf8(next.promptText, budget) : next.promptText,
      responseText: typeof next.responseText === 'string' ? truncateUtf8(next.responseText, budget) : next.responseText,
      raw: typeof next.raw === 'string' ? truncateUtf8(next.raw, budget) : next.raw,
    };
    if (nextDisclosure === 'full' || nextDisclosure === 'redacted' || nextDisclosure === 'masked') {
      nextDisclosure = 'truncated';
    }
  }

  return { payload: next, contentDisclosure: nextDisclosure };
}

export function visibleContentFromPayload(
  payload: Record<string, unknown>,
  contentKind: string,
  disclosure: string,
): { promptText: string | null; responseText: string | null; raw: string | null } {
  if (hidesTrajectoryContent(disclosure)) {
    return { promptText: null, responseText: null, raw: null };
  }
  const bodyText = bodyToVisibleText(payload.body);
  const promptText =
    stringOrNull(payload.promptText) ??
    (contentKind === 'prompt' ? bodyText : null);
  const responseText =
    stringOrNull(payload.responseText) ??
    (contentKind === 'response' ? bodyText : null);
  return {
    promptText,
    responseText,
    raw: stringOrNull(payload.raw) ?? bodyText,
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function bodyToVisibleText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as { stringValue?: unknown };
    if (typeof record.stringValue === 'string' && record.stringValue.trim()) {
      return record.stringValue;
    }
  }
  return null;
}
