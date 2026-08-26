/** Filtering on `createdAt` alone skips rows when a page boundary lands inside a
 * batch that shares a millisecond, so a caller with a cursor id pages on
 * `(createdAt, id)`. */
export function createdAtKeyset(options: { since?: string | null; sinceId?: string | null }) {
  const since = options.since ? new Date(options.since) : null;
  if (!since || !Number.isFinite(since.getTime())) return {};
  const sinceId = options.sinceId?.trim();
  if (!sinceId) return { createdAt: { gt: since } };
  return {
    OR: [{ createdAt: { gt: since } }, { createdAt: since, id: { gt: sinceId } }],
  };
}

export function clampPageLimit(
  requested: number | undefined,
  fallback: number,
  max: number,
): number {
  return Math.max(1, Math.min(requested ?? fallback, max));
}

export function pageParams(url: URL): { since: string | null; sinceId: string | null; limit?: number } {
  const requestedLimit = Number(url.searchParams.get('limit'));
  return {
    since: url.searchParams.get('since'),
    sinceId: url.searchParams.get('sinceId'),
    ...(Number.isFinite(requestedLimit) && requestedLimit > 0 ? { limit: requestedLimit } : {}),
  };
}
