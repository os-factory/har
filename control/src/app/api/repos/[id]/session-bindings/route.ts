import { NextResponse } from 'next/server';
import { listSessionBindings, syncSessionBindings } from '@/server/session-attribution';

/** Session → slot binding timeline (ADR 0003). `?agentTool=&sessionId=` narrow the list. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
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
