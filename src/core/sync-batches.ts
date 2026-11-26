/** Per-request byte budget: a single POST of a large run history can get the
 * connection dropped (undici UND_ERR_SOCKET), so every sync request stays under this. */
const DEFAULT_MAX_BATCH_BYTES = 4 * 1024 * 1024;

export function maxSyncBatchBytes(): number {
  const raw = Number(process.env.HAR_SYNC_MAX_BATCH_BYTES);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_BATCH_BYTES;
}

/** Batches under `maxBytes` of serialized items, and at most `maxRows` items each. */
export function chunkBySerializedSize<T>(
  items: T[],
  maxBytes: number,
  maxRows: number = Number.POSITIVE_INFINITY,
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentBytes = 0;

  for (const item of items) {
    const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8');
    if (current.length > 0 && (currentBytes + itemBytes > maxBytes || current.length >= maxRows)) {
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
