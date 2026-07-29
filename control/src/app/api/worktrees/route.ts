import { NextResponse } from 'next/server';
import { deleteSessionWorktrees } from '@/server/worktree-delete';

export async function DELETE(request: Request) {
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  try {
    const result = await deleteSessionWorktrees(body);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
