import { NextResponse } from 'next/server';
import { deleteRepository, getRepository } from '@/server/repositories';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const repo = await getRepository(id);
  if (!repo) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(repo);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    const { searchParams } = new URL(request.url);
    body = {
      deleteWorktrees: searchParams.get('deleteWorktrees') === 'true',
    };
  }

  try {
    const result = await deleteRepository(id, body);
    if (!result) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
