import { NextResponse } from 'next/server';
import { ingestV2Proofs } from '@/server/ingest-v2';
import { readJsonBody } from '@/server/ingest-v2-http';

export const runtime = 'nodejs';

/** `POST v2/proofs`: DSSE envelopes of Factory Commits statements, keyed by the digest Mission Control recomputes. */
export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
  const reply = await ingestV2Proofs(body.value);
  return NextResponse.json(reply.body, { status: reply.status });
}
