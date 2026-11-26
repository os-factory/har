import { NextResponse } from 'next/server';
import { IngestV2EvidenceMissingRequestSchema } from '@har/schemas';
import { missingEvidence } from '@/server/evidence-store';
import { readJsonBody } from '@/server/ingest-v2-http';

export const runtime = 'nodejs';

/** `POST v2/evidence/missing`: which of these digests Mission Control lacks, with where to upload each. */
export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
  const parsed = IngestV2EvidenceMissingRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    return NextResponse.json({ error: 'not a valid v2/evidence/missing body', issues: parsed.error.issues }, { status: 400 });
  }
  return NextResponse.json({ missing: await missingEvidence(parsed.data.digests) });
}
