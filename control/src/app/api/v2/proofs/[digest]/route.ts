import { NextResponse } from 'next/server';
import { getProofView } from '@/server/work-unit-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** `GET /api/v2/proofs/{statementDigest}` (`sha256:<hex>` or `<hex>`): the envelope as received, decoded, with its commits. */
export async function GET(_request: Request, { params }: { params: Promise<{ digest: string }> }) {
  const { digest } = await params;
  const view = await getProofView(decodeURIComponent(digest));
  if (!view) return NextResponse.json({ error: 'unknown proof' }, { status: 404 });
  return NextResponse.json(view);
}
