import { NextResponse } from 'next/server';
import { getAttemptRecord } from '@/server/attempt-record';

/** Record of one occupancy (#348). `key` is the URL-encoded occupancy key. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; key: string }> },
) {
  const { id, key } = await params;
  const record = await getAttemptRecord(id, decodeURIComponent(key));
  if (!record) return NextResponse.json({ error: 'Attempt not found' }, { status: 404 });
  return NextResponse.json(record);
}
