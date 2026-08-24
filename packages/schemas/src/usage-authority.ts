import { PRE_DEDUPE_HARVEST_VERSION } from './schema';

/**
 * The minimum a usage row must expose for the merge rules below — every store
 * keeps `sources` and `harvestVersion` in its own shape (JSON column, string[]).
 */
export interface UsageAuthorityRow {
  sources?: readonly string[] | null;
  harvestVersion?: number | null;
}

export function usageHarvestVersion(row: UsageAuthorityRow | null | undefined): number {
  const version = Number(row?.harvestVersion ?? PRE_DEDUPE_HARVEST_VERSION);
  return Number.isFinite(version) && version > 0 ? Math.floor(version) : PRE_DEDUPE_HARVEST_VERSION;
}

function includesSource(row: UsageAuthorityRow | null | undefined, source: string): boolean {
  return (row?.sources ?? []).includes(source);
}

/**
 * True when `incoming` was produced by a newer harvest algorithm than
 * `existing` and may therefore replace it outright — including lowering it,
 * which is the whole point: the pre-dedupe harvest billed a repeated Claude
 * message once per transcript record and so reads high.
 *
 * OTLP rows are excluded on both sides. They are accumulated in the store one
 * batch at a time rather than recomputed from a transcript, so replacing one
 * would drop every earlier batch; those keep the max-merge that protects them.
 */
export function harvestSupersedes(
  existing: UsageAuthorityRow | null | undefined,
  incoming: UsageAuthorityRow | null | undefined,
): boolean {
  if (!existing || !incoming) return false;
  if (includesSource(existing, 'otel') || includesSource(incoming, 'otel')) return false;
  return usageHarvestVersion(incoming) > usageHarvestVersion(existing);
}

/**
 * The version a blended (max-merged) row should carry. Only a harvest
 * contributes a version, and the oldest one decides: a row is no more
 * trustworthy than its least trustworthy half.
 */
export function mergedHarvestVersion(
  existing: UsageAuthorityRow | null | undefined,
  incoming: UsageAuthorityRow | null | undefined,
): number {
  if (!includesSource(existing, 'harvest')) return usageHarvestVersion(incoming);
  if (!includesSource(incoming, 'harvest')) return usageHarvestVersion(existing);
  return Math.min(usageHarvestVersion(existing), usageHarvestVersion(incoming));
}

/**
 * True when a row carries harvested tokens from before the harvest was
 * versioned, so its totals read high and cannot be recomputed once the agent's
 * transcript is gone. Pure OTLP rows were never affected and are not flagged.
 */
export function isPreDedupeUsage(row: UsageAuthorityRow | null | undefined): boolean {
  if (!includesSource(row, 'harvest')) return false;
  return usageHarvestVersion(row) <= PRE_DEDUPE_HARVEST_VERSION;
}
