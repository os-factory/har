import { NextResponse } from 'next/server';
import { listUsageObservationChanges } from '@/server/session-attribution';
import { clampPageLimit, pageParams } from '@/server/pagination';

const PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 5000;

/**
 * Usage observations in change order (ADR 0003), paged on `(updatedAt, id)` with
 * `?since=&sinceId=&limit=`. A mirror (har-portal) reads this, not the `observedAt`
 * list, so late harvests and filled-in provider costs reach it.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const page = pageParams(new URL(request.url));
  if (page.since && Number.isNaN(new Date(page.since).getTime())) {
    return NextResponse.json({ error: 'since must be an ISO date-time' }, { status: 400 });
  }
  const observations = await listUsageObservationChanges(id, {
    since: page.since,
    sinceId: page.sinceId,
    limit: clampPageLimit(page.limit, PAGE_SIZE, MAX_PAGE_SIZE),
  });
  return NextResponse.json({ observations });
}
