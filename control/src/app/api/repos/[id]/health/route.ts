import { NextResponse } from 'next/server';
import { getRepositoryHealth, getVerificationTrend } from '@/server/repositories';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const health = await getRepositoryHealth(id);
  if (!health) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const trendRaw = await getVerificationTrend(id);
  const byDate = new Map<string, { pass: number; fail: number }>();
  for (const point of trendRaw) {
    const entry = byDate.get(point.date) ?? { pass: 0, fail: 0 };
    if (point.status === 'pass') entry.pass += 1;
    else entry.fail += 1;
    byDate.set(point.date, entry);
  }
  const trend = [...byDate.entries()].map(([date, counts]) => ({ date, ...counts }));

  return NextResponse.json({ ...health, trend });
}
