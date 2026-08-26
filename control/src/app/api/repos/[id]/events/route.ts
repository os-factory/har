import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { SyncSessionEventsInputSchema } from '@har/schemas';
import { listSessionEventsForRepo, syncSessionEvents } from '@/server/session-events';
import { pageParams } from '@/server/pagination';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const events = await listSessionEventsForRepo(id, pageParams(new URL(request.url)));
  return NextResponse.json({ events });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const parsed = SyncSessionEventsInputSchema.parse(body);
    const result = await syncSessionEvents(
      id,
      parsed.events.map((ev) => ({
        sessionKey: ev.sessionKey,
        agentId: ev.agentId,
        agentTool: ev.agentTool,
        eventName: ev.eventName,
        sequence: ev.sequence,
        timestamp: new Date(ev.timestamp),
        attributes: ev.attributes as Prisma.InputJsonValue | undefined,
        promptText: ev.promptText,
        responseText: ev.responseText,
        rawTruncated: ev.rawTruncated,
        source: ev.source,
        workUnitId: ev.workUnitId,
        attemptId: ev.attemptId,
      })),
    );
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
