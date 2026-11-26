import { createHash } from 'crypto';
import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db';
import type { AttrMap, OtelIngestResult, ParsedMetricPoint } from '@/server/otel-ingest';

/**
 * OTLP metrics from otel-hook (ADR 0005 section 5).
 *
 * otel-hook metrics are running totals, so Mission Control keeps the latest
 * value of each series and never sums points: a point replaces the stored
 * value when its timestamp is not older. A series is identified like an OTLP
 * series: the metric name, the resource attributes and the point attributes.
 *
 * Every provider's otel-hook metrics are kept, Claude Code included: otel-hook
 * is the only source of agent telemetry. They are stored, never booked as
 * usage, which comes from generation spans only, so nothing is counted twice.
 */

export const OTELHOOK_PROVIDER_ATTR = 'otelhook.provider.id';

/** `otelhook.provider.id` of a resource or point, normalized, when otel-hook produced it. */
export function otelHookProviderId(attributes: AttrMap): string | null {
  const raw = attributes[OTELHOOK_PROVIDER_ATTR];
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim().toLowerCase();
  return value || null;
}

/**
 * The otel-hook provider of one point. otel-hook puts `otelhook.provider.id`
 * on each data point, not on the resource (its resource only names the
 * service), so a resource-only check dropped every otel-hook metric.
 */
export function pointProviderId(resource: AttrMap, point: Pick<ParsedMetricPoint, 'attributes'>): string | null {
  return otelHookProviderId(resource) ?? otelHookProviderId(point.attributes);
}

function sortedEntries(map: AttrMap): Array<[string, unknown]> {
  return Object.keys(map)
    .sort()
    .map((key) => [key, map[key]]);
}

/** sha256 of the series identity: name, resource attributes, point attributes. */
export function metricSeriesKey(name: string, resource: AttrMap, attributes: AttrMap): string {
  return createHash('sha256')
    .update(JSON.stringify([name, sortedEntries(resource), sortedEntries(attributes)]))
    .digest('hex');
}

function temporalityName(point: ParsedMetricPoint): string {
  if (point.kind === 'gauge') return 'gauge';
  if (point.temporality === 1) return 'delta';
  if (point.temporality === 2) return 'cumulative';
  return 'unspecified';
}

function text(...values: unknown[]): string | null {
  for (const value of values) {
    if (value === undefined || value === null) continue;
    const out = String(value).trim();
    if (out) return out;
  }
  return null;
}

function nanosToDate(value: string): Date | null {
  if (!value || !/^\d+$/.test(value) || value === '0') return null;
  return new Date(Number(BigInt(value) / 1_000_000n));
}

/** Store the latest value of each series of one resource's points. */
export async function ingestOtelHookMetrics(
  resource: AttrMap,
  points: ParsedMetricPoint[],
  db: Pick<PrismaClient, 'metricSeries'> = prisma,
): Promise<OtelIngestResult> {
  const result: OtelIngestResult = { accepted: 0, dropped: 0, reasons: [] };
  // Within one request the newest point of a series wins too.
  const latest = new Map<string, ParsedMetricPoint>();
  for (const point of points) {
    if (!pointProviderId(resource, point)) {
      result.dropped += 1;
      result.reasons.push('otel-hook metrics without otelhook.provider.id');
      continue;
    }
    if (!Number.isFinite(point.value)) {
      result.dropped += 1;
      result.reasons.push(`metric ${point.name}: not a number`);
      continue;
    }
    const key = metricSeriesKey(point.name, resource, point.attributes);
    const seen = latest.get(key);
    if (!seen || point.time >= seen.time) latest.set(key, point);
  }
  for (const [seriesKey, point] of latest) {
    const attrs = point.attributes;
    const data = {
      name: point.name,
      unit: point.unit ?? null,
      providerId: pointProviderId(resource, point)!,
      temporality: temporalityName(point),
      value: point.value,
      startTime: nanosToDate(point.startTimeUnixNano),
      time: point.time,
      attributes: attrs as Prisma.InputJsonValue,
      resource: resource as Prisma.InputJsonValue,
      workUnitId: text(attrs['factory.work_unit.id'], resource['factory.work_unit.id']),
      attemptId: text(attrs['factory.attempt.id'], resource['factory.attempt.id']),
      factoryRunId: text(attrs['factory.run.id'], resource['factory.run.id']),
      sessionId: text(attrs['session.id'], resource['session.id'], attrs['otelhook.session.id']),
    };
    const stored = await db.metricSeries.findUnique({ where: { seriesKey }, select: { id: true, time: true } });
    if (stored && stored.time > point.time) {
      // An older point delivered late: the stored value is newer.
      result.accepted += 1;
      continue;
    }
    if (stored) await db.metricSeries.update({ where: { id: stored.id }, data });
    else {
      try {
        await db.metricSeries.create({ data: { ...data, seriesKey } });
      } catch (error) {
        // A concurrent export created the series: keep whichever point is newer.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error;
        await db.metricSeries.updateMany({ where: { seriesKey, time: { lte: point.time } }, data });
      }
    }
    result.accepted += 1;
  }
  return result;
}
