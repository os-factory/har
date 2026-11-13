import { NextResponse } from 'next/server';
import { listSessionBindings, listSessionBindingsPage, syncSessionBindings } from '@/server/session-attribution';
import { clampPageLimit, pageParams } from '@/server/pagination';

const PAGE_SIZE = 1000;
const MAX_PAGE_SIZE = 5000;

/**
 * Session → slot binding timeline (ADR 0003). `?agentTool=&sessionId=` narrow the list.
 * With `?limit=` (and `since` / `sinceId`), it pages in storage order on `(createdAt, id)`
 * instead — how a mirror such as har-portal reads every binding recorded since its last sync.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  if (url.searchParams.has('limit')) {
    const page = pageParams(url);
    const bindings = await listSessionBindingsPage(id, {
      since: page.since,
      sinceId: page.sinceId,
      limit: clampPageLimit(page.limit, PAGE_SIZE, MAX_PAGE_SIZE),
    });
    return NextResponse.json({ bindings });
  }
  const bindings = await listSessionBindings(id, {
    ...(url.searchParams.get('agentTool') ? { agentTool: url.searchParams.get('agentTool')! } : {}),
    ...(url.searchParams.get('sessionId') ? { sessionId: url.searchParams.get('sessionId')! } : {}),
  });
  return NextResponse.json({ bindings });
}

/** `SyncSessionBindingsInput`; idempotent per (agentTool, sessionId, subagentId, kind, slotId, at). */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    return NextResponse.json(await syncSessionBindings(id, await request.json()));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
