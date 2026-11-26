import { NextResponse } from 'next/server';
import { ingestV2Capabilities } from '@/server/ingest-v2';

export const runtime = 'nodejs';

/** `GET v2/capabilities` (ADR 0005 section 2): the ingest contract version and what this receiver accepts. */
export async function GET() {
  return NextResponse.json(ingestV2Capabilities());
}
