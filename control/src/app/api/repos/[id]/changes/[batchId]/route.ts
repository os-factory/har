import { NextResponse } from 'next/server';
import { getChangeBatchDiff } from '@/server/change-batch-diff';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; batchId: string }> },
) {
  const { id, batchId } = await params;

  try {
    const result = await getChangeBatchDiff(id, batchId);
    if (!result) return NextResponse.json({ error: 'Change batch not found' }, { status: 404 });
    return NextResponse.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unable to load change batch diff';
    return NextResponse.json({ error: message }, { status: 422 });
  }
}
