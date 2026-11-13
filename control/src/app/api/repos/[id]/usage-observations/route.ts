import { NextResponse } from 'next/server';
import { listUsageObservations, syncUsageObservations } from '@/server/session-attribution';

const MAX_LIMIT = 5000;

/** Usage observations (ADR 0003). `?agentTool=&sessionId=&since=&limit=` narrow the list. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const since = url.searchParams.get('since');
  const sinceDate = since ? new Date(since) : undefined;
  if (sinceDate && Number.isNaN(sinceDate.getTime())) {
    return NextResponse.json({ error: 'since must be an ISO date-time' }, { status: 400 });
  }
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 1000) || 1000, 1), MAX_LIMIT);
  const observations = await listUsageObservations(
    id,
    {
      ...(url.searchParams.get('agentTool') ? { agentTool: url.searchParams.get('agentTool')! } : {}),
      ...(url.searchParams.get('sessionId') ? { sessionId: url.searchParams.get('sessionId')! } : {}),
      ...(sinceDate ? { since: sinceDate } : {}),
    },
    limit,
  );
  return NextResponse.json({ observations });
}

/** `SyncUsageObservationsInput`; idempotent per (agentTool, sessionId, observationKey). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    return NextResponse.json(await syncUsageObservations(id, await request.json()));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
