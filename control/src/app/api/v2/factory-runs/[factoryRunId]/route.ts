import { NextResponse } from 'next/server';
import { getFactoryRunView } from '@/server/work-unit-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `GET /api/v2/factory-runs/{factoryRunId}`: one factory run with its stages, evidence links, proof and commits. */
export async function GET(_request: Request, { params }: { params: Promise<{ factoryRunId: string }> }) {
  const { factoryRunId } = await params;
  const view = await getFactoryRunView(decodeURIComponent(factoryRunId));
  if (!view) return NextResponse.json({ error: 'unknown factory run' }, { status: 404 });
  return NextResponse.json(view);
}
