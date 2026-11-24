/** Per-request byte budget. har-portal refuses a body over 8 MiB (HTTP 413),
 * and a single POST of a large run history can get the connection dropped
 * (undici UND_ERR_SOCKET), so every sync request stays under this. */
const DEFAULT_MAX_BATCH_BYTES = 4 * 1024 * 1024;

export function maxSyncBatchBytes(): number {
  const raw = Number(process.env.HAR_SYNC_MAX_BATCH_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BATCH_BYTES;
}

export function chunkBySerializedSize<T>(items: T[], maxBytes: number): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (current.length > 0 && currentBytes + itemBytes > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += itemBytes;
  }
  if (current.length > 0) batches.push(current);

  return batches;
}

/** Per-request row cap for any one collection. har-portal refuses a request
 * whose collection has more than 20,000 rows (HTTP 413). */
const DEFAULT_MAX_BATCH_ROWS = 10_000;

export function maxSyncBatchRows(): number {
  const raw = Number(process.env.HAR_SYNC_MAX_BATCH_ROWS);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_BATCH_ROWS;
}

/** Rows that must land in the same request (one provider session's usage, or
 * a single record), sent under the body field `key`. */
export interface SyncUnit<T = unknown> {
  key: string;
  rows: T[];
}

export interface PackedSyncBody {
  body: Record<string, unknown>;
  units: SyncUnit[];
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * Pack `units` into request bodies under one byte and row budget per request.
 * The first body carries `head`; later ones carry only `continuation` (e.g.
 * `{ path }`). With `head` null every body is a continuation, and none is empty. Units keep their order, so a dependency sent earlier (work units
 * before attempts) lands in an earlier request or the same one. A unit is never
 * split: one larger than the budget goes alone.
 */
export function packSyncBodies(
  head: Record<string, unknown> | null,
  continuation: Record<string, unknown>,
  units: SyncUnit[],
  maxBytes: number,
  maxRows: number = maxSyncBatchRows(),
): PackedSyncBody[] {
  const packed: PackedSyncBody[] = [];
  let current: PackedSyncBody = { body: { ...(head ?? continuation) }, units: [] };
  let currentBytes = serializedBytes(current.body);
  let isHead = head !== null;

  const flush = (): void => {
    packed.push(current);
    current = { body: { ...continuation }, units: [] };
    currentBytes = serializedBytes(continuation);
    isHead = false;
  };

  const fits = (unit: SyncUnit, rowBytes: number): boolean => {
    const existing = current.body[unit.key] as unknown[] | undefined;
    const keyBytes = existing ? 0 : Buffer.byteLength(unit.key, 'utf8') + 6;
    const rowCount = (existing?.length ?? 0) + unit.rows.length;
    return currentBytes + keyBytes + rowBytes <= maxBytes && rowCount <= maxRows;
  };

  for (const unit of units) {
    if (unit.rows.length === 0) continue;
    // Each row costs its JSON plus a comma.
    const rowBytes = unit.rows.reduce<number>((sum, row) => sum + serializedBytes(row) + 1, 0);
    if ((isHead || current.units.length > 0) && !fits(unit, rowBytes)) flush();
    let rows = current.body[unit.key] as unknown[] | undefined;
    if (!rows) {
      rows = [];
      current.body[unit.key] = rows;
      currentBytes += Buffer.byteLength(unit.key, 'utf8') + 6;
    }
    rows.push(...unit.rows);
    current.units.push(unit);
    currentBytes += rowBytes;
  }
  if (isHead || current.units.length > 0) packed.push(current);
  return packed;
}
