import { NextResponse } from 'next/server';
import { getReportedWorktrees, syncReportedWorktrees } from '@/server/reported-worktrees';

/** The repository's linked git worktrees as the CLI last reported them from the host. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const reported = await getReportedWorktrees(id);
  if (!reported) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(reported);
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const result = await syncReportedWorktrees(id, await request.json());
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const status = message.startsWith('Repository not found') ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
