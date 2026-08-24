import { PRE_DEDUPE_HARVEST_VERSION } from './schema';

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
 * Whether `incoming` may replace `existing` outright, lowering it if need be.
 *
 * OTLP rows are excluded on both sides: they accumulate one batch at a time
 * rather than being recomputed, so replacing one would drop every earlier batch.
 */
export function harvestSupersedes(
  existing: UsageAuthorityRow | null | undefined,
  incoming: UsageAuthorityRow | null | undefined,
): boolean {
  if (!existing || !incoming) return false;
  if (includesSource(existing, 'otel') || includesSource(incoming, 'otel')) return false;
  return usageHarvestVersion(incoming) > usageHarvestVersion(existing);
}

/** A blended row is no more trustworthy than its oldest harvested half. */
export function mergedHarvestVersion(
  existing: UsageAuthorityRow | null | undefined,
  incoming: UsageAuthorityRow | null | undefined,
): number {
  if (!includesSource(existing, 'harvest')) return usageHarvestVersion(incoming);
  if (!includesSource(incoming, 'harvest')) return usageHarvestVersion(existing);
  return Math.min(usageHarvestVersion(existing), usageHarvestVersion(incoming));
}

/** Pure OTLP rows were never affected by the harvest bug, so they never flag. */
export function isPreDedupeUsage(row: UsageAuthorityRow | null | undefined): boolean {
  if (!includesSource(row, 'harvest')) return false;
  return usageHarvestVersion(row) <= PRE_DEDUPE_HARVEST_VERSION;
}
