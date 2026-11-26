import { NextResponse } from 'next/server';
import { getWorkUnitView } from '@/server/work-unit-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * `GET /api/v2/work-units/{workUnitId}[?repository=<repository url>]`: the work
 * unit view (ADR 0005 section 3). A work unit id is scoped to its repository;
 * when several repositories use it, the reply is 409 with their URLs.
 */
export async function GET(request: Request, { params }: { params: Promise<{ workUnitId: string }> }) {
  const { workUnitId } = await params;
  const url = new URL(request.url);
  const repositoryUrl = url.searchParams.has('repository') ? url.searchParams.get('repository') : undefined;
  const lookup = await getWorkUnitView(decodeURIComponent(workUnitId), { repositoryUrl });
  if (lookup.status === 'not-found') return NextResponse.json({ error: 'unknown work unit' }, { status: 404 });
  if (lookup.status === 'ambiguous') {
    return NextResponse.json(
      { error: 'several repositories use this work unit id: pass ?repository=<url>', repositories: lookup.repositories },
      { status: 409 },
    );
  }
  return NextResponse.json(lookup.view);
}
