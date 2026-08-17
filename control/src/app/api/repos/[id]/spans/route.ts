import { NextResponse } from 'next/server';
import { listSessionSpansForRepo } from '@/server/session-spans';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const since = url.searchParams.get('since');
  const requestedLimit = Number(url.searchParams.get('limit'));
  const spans = await listSessionSpansForRepo(id, {
    since,
    ...(Number.isFinite(requestedLimit) && requestedLimit > 0
      ? { limit: requestedLimit }
      : {}),
  });
  return NextResponse.json({
    spans: spans.map((span) => ({
      ...span,
      startTime: span.startTime.toISOString(),
      endTime: span.endTime?.toISOString() ?? null,
      createdAt: span.createdAt.toISOString(),
    })),
  });
}
