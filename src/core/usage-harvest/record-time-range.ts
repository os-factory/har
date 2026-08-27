export interface RecordTimeRange {
  firstAt: string;
  lastAt: string;
}

function recordTimestamp(record: unknown): number | null {
  if (!record || typeof record !== 'object') return null;
  const payload = record as { timestamp?: unknown; ts?: unknown };
  const raw = typeof payload.timestamp === 'string' ? payload.timestamp : payload.ts;
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

/** Metadata records carry no timestamp, so scan for the extremes */
export function recordTimeRange(records: unknown[]): RecordTimeRange | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const record of records) {
    const ms = recordTimestamp(record);
    if (ms === null) continue;
    if (first === null || ms < first) first = ms;
    if (last === null || ms > last) last = ms;
  }
  if (first === null || last === null) return null;
  return { firstAt: new Date(first).toISOString(), lastAt: new Date(last).toISOString() };
}
