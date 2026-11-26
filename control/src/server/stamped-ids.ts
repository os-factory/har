import type { AttrMap } from '@/server/otel-ingest';

/**
 * Identity stamped on telemetry where it is produced (ADR 0004 section 3).
 * A receiver stores these as indexed columns (ADR 0005 section 3) and never
 * resolves them itself: a stamp wins over anything Mission Control's ADR 0003
 * resolver would derive.
 */
export const STAMPED_ATTRS = ['factory.work_unit.id', 'factory.attempt.id', 'factory.run.id', 'session.id'] as const;

export interface StampedIds {
  workUnitId: string | null;
  attemptId: string | null;
  factoryRunId: string | null;
  sessionId: string | null;
}

function first(maps: AttrMap[], key: string): string | null {
  for (const map of maps) {
    const value = map?.[key];
    if (value === undefined || value === null) continue;
    const out = String(value).trim();
    if (out) return out;
  }
  return null;
}

/** The stamped ids of a record, from its own attributes first, then its resource. */
export function stampedIds(...maps: AttrMap[]): StampedIds {
  return {
    workUnitId: first(maps, 'factory.work_unit.id'),
    attemptId: first(maps, 'factory.attempt.id'),
    factoryRunId: first(maps, 'factory.run.id'),
    sessionId: first(maps, 'session.id') ?? first(maps, 'otelhook.session.id'),
  };
}

/** The record's attributes plus the stamps only its resource carries, so the stored attributes keep them. */
export function withResourceStamps(resource: AttrMap, attributes: AttrMap): AttrMap {
  const out: AttrMap = { ...attributes };
  for (const key of STAMPED_ATTRS) {
    if (out[key] === undefined && resource?.[key] !== undefined) out[key] = resource[key];
  }
  return out;
}
