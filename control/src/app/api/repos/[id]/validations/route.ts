import { NextResponse } from 'next/server';
import { listChangeBatches, syncChangeBatches } from '@/server/change-batches';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? '100');
  const changeBatches = await listChangeBatches(id, limit);
  return NextResponse.json({ changeBatches });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const result = await syncChangeBatches(id, body);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
