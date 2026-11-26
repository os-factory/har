import { NextResponse } from 'next/server';
import { isSha256, MAX_EVIDENCE_BYTES, readEvidence, storeEvidence } from '@/server/evidence-store';

export const runtime = 'nodejs';

type Params = { params: Promise<{ sha256: string }> };

/** `PUT v2/evidence/{sha256}`: the file bytes; stored only when they hash to the digest in the path. */
export async function PUT(request: Request, { params }: Params) {
  const { sha256 } = await params;
  if (!isSha256(sha256)) return NextResponse.json({ error: 'not a lowercase hex sha256' }, { status: 400 });
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_EVIDENCE_BYTES) {
    return NextResponse.json({ error: `larger than ${MAX_EVIDENCE_BYTES} bytes` }, { status: 413 });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  const result = await storeEvidence(sha256, bytes, request.headers.get('content-type'));
  switch (result.status) {
    case 'mismatch':
      return NextResponse.json({ error: `the bytes digest to ${result.actual}, not ${result.expected}` }, { status: 422 });
    case 'too-large':
      return NextResponse.json({ error: `larger than ${MAX_EVIDENCE_BYTES} bytes` }, { status: 413 });
    default:
      return NextResponse.json({ sha256: result.sha256, size: result.size, status: result.status }, {
        status: result.status === 'stored' ? 201 : 200,
      });
  }
}

/** The stored bytes, so a person can open a stage log or artifact and check it against the proof. */
export async function GET(_request: Request, { params }: Params) {
  const { sha256 } = await params;
  if (!isSha256(sha256)) return NextResponse.json({ error: 'not a lowercase hex sha256' }, { status: 400 });
  const evidence = await readEvidence(sha256);
  if (!evidence) return NextResponse.json({ error: 'not stored here' }, { status: 404 });
  return new Response(new Uint8Array(evidence.bytes), {
    headers: {
      'content-type': evidence.mediaType,
      'content-length': String(evidence.size),
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'cache-control': 'private, max-age=31536000, immutable',
    },
  });
}
