import { NextResponse } from 'next/server';
import { listReportedUsage } from '@/server/session-attribution';

/**
 * Provider-reported session totals (ADR 0003): never attributed to a slot, only
 * compared with the sum of the session's observations. One row per session.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  return NextResponse.json({ reportedUsage: await listReportedUsage(id) });
}
