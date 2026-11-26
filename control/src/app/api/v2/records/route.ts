import { NextResponse } from 'next/server';
import { ingestV2Records } from '@/server/ingest-v2';
import { readJsonBody } from '@/server/ingest-v2-http';

export const runtime = 'nodejs';

/** `POST v2/records` (ADR 0005 section 3): typed records, each upserted by its natural key. */
export async function POST(request: Request) {
  const body = await readJsonBody(request);
  if (!body.ok) return NextResponse.json({ error: body.error }, { status: 400 });
  const reply = await ingestV2Records(body.value);
  return NextResponse.json(reply.body, { status: reply.status });
}
