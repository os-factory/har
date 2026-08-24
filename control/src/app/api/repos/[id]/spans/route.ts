import { NextResponse } from 'next/server';
import { listSessionSpansForRepo } from '@/server/session-spans';
import { pageParams } from '@/server/pagination';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const spans = await listSessionSpansForRepo(id, pageParams(new URL(request.url)));
  return NextResponse.json({
    spans: spans.map((span) => ({
      ...span,
      startTime: span.startTime.toISOString(),
      endTime: span.endTime?.toISOString() ?? null,
      createdAt: span.createdAt.toISOString(),
    })),
  });
}
