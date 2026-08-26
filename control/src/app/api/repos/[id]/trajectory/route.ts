import { NextResponse } from 'next/server';
import {
  listTrajectoryForRepo,
  serializeTrajectoryForEgress,
} from '@/server/trajectory-ledger';
import { pageParams } from '@/server/pagination';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const records = await listTrajectoryForRepo(id, pageParams(new URL(request.url)));
  return NextResponse.json({ records: records.map(serializeTrajectoryForEgress) });
}
