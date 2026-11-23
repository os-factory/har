import { NextResponse } from 'next/server';
import { ingestOtelTracesBody } from '@/server/otel-ingest';
import { scheduleOtlpForward } from '@/server/otlp-forward';

export const runtime = 'nodejs';

/** `x-har-otlp-forward: skip` — store without forwarding (the sender owns destination delivery). */
function skipsForward(request: Request): boolean {
  return request.headers.get('x-har-otlp-forward')?.trim().toLowerCase() === 'skip';
}

export async function POST(request: Request) {
  try {
    const body = Buffer.from(await request.arrayBuffer());
    const result = await ingestOtelTracesBody(body, request.headers.get('content-type'));
    // Copy to configured OTLP destinations after the response; never affects it.
    // A payload the CLI already delivered to the destinations itself (a
    // verification trace spooled while Mission Control was down) is stored only.
    if (!skipsForward(request)) scheduleOtlpForward('traces', body, request);
    return NextResponse.json(
      {
        partialSuccess: {
          rejectedDataPoints: result.dropped,
        },
        har: result,
      },
      { status: 200 },
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[otel-traces]', message);
    return NextResponse.json(
      {
        partialSuccess: { rejectedDataPoints: 0 },
        har: { accepted: 0, dropped: 0, reasons: [message] },
      },
      { status: 200 },
    );
  }
}
