import { NextResponse } from 'next/server';
import { listRuns, syncRuns } from '@/server/repositories';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit') ?? '50');
  const runs = await listRuns(id, limit);
  return NextResponse.json({ runs });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const result = await syncRuns(id, body);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
