import { NextResponse } from 'next/server';
import {
  listTrajectoryForRepo,
  serializeTrajectoryForEgress,
} from '@/server/trajectory-ledger';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const url = new URL(request.url);
  const since = url.searchParams.get('since');
  const requestedLimit = Number(url.searchParams.get('limit'));
  const records = await listTrajectoryForRepo(id, {
    since,
    ...(Number.isFinite(requestedLimit) && requestedLimit > 0
      ? { limit: requestedLimit }
      : {}),
  });
  return NextResponse.json({ records: records.map(serializeTrajectoryForEgress) });
}
