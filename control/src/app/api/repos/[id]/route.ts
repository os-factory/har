import { NextResponse } from 'next/server';
import { getRepository } from '@/server/repositories';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const repo = await getRepository(id);
  if (!repo) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json(repo);
}
