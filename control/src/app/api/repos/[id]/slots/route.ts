import { NextResponse } from 'next/server';
import { getRepository, syncSlots } from '@/server/repositories';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const repo = await getRepository(id);
  if (!repo) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ slots: repo.slots });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const result = await syncSlots(id, body);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
