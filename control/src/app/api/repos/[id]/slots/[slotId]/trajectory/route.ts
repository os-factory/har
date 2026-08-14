import { AgentToolSchema } from '@har/schemas';
import { NextResponse } from 'next/server';
import {
  cursorForTrajectory,
  decodeTrajectoryCursor,
  listTrajectoryAfter,
  listTrajectoryHistory,
  serializeTrajectoryPage,
  serializeTrajectoryRecord,
} from '@/server/trajectory-ledger';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; slotId: string }> },
) {
  const { id, slotId } = await params;
  const url = new URL(request.url);
  const sessionKey = url.searchParams.get('sessionKey')?.trim();
  const parsedTool = AgentToolSchema.safeParse(url.searchParams.get('agentTool'));
  const agentId = Number(slotId);
  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey is required' }, { status: 400 });
  }
  if (!parsedTool.success) {
    return NextResponse.json({ error: 'agentTool is invalid' }, { status: 400 });
  }
  if (!Number.isInteger(agentId) || agentId < 1) {
    return NextResponse.json({ error: 'slotId is invalid' }, { status: 400 });
  }

  const before = url.searchParams.get('before') ?? undefined;
  const after = url.searchParams.get('after') ?? undefined;
  const requestedLimit = Number(url.searchParams.get('limit') ?? 100);
  try {
    if (before && after) {
      return NextResponse.json({ error: 'before and after are mutually exclusive' }, { status: 400 });
    }
    if (before) decodeTrajectoryCursor(before);
    if (after) decodeTrajectoryCursor(after);
    const limit = Math.max(
      1,
      Math.min(Number.isFinite(requestedLimit) ? requestedLimit : 100, after ? 999 : 200),
    );
    const scope = { repositoryId: id, agentId, sessionKey, agentTool: parsedTool.data };
    if (after) {
      const rows = await listTrajectoryAfter(scope, after, limit + 1);
      const records = rows.slice(0, limit);
      const latest = records.at(-1);
      return NextResponse.json({
        records: records.map(serializeTrajectoryRecord),
        hasMore: rows.length > limit,
        nextBefore: null,
        latest: latest ? cursorForTrajectory(latest) : after,
        nextAfter: rows.length > limit && latest ? cursorForTrajectory(latest) : null,
      });
    }
    const page = await listTrajectoryHistory(
      scope,
      {
        before,
        limit,
      },
    );
    return NextResponse.json(serializeTrajectoryPage(page));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
