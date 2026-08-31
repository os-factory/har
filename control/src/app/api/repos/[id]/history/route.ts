import { NextResponse } from 'next/server';
import { getSessionHistory } from '@/server/session-history';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const history = await getSessionHistory(id);
  if (!history) return NextResponse.json({ error: 'Repository not found' }, { status: 404 });
  return NextResponse.json(history);
}
