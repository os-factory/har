import { NextResponse } from 'next/server';
import { ingestOtelMetricsBody } from '@/server/otel-ingest';
import { scheduleOtlpForward } from '@/server/otlp-forward';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const body = Buffer.from(await request.arrayBuffer());
    const result = await ingestOtelMetricsBody(body, request.headers.get('content-type'));
    // Copy to configured OTLP destinations after the response; never affects it.
    scheduleOtlpForward('metrics', body, request);
    // OTLP success response (partial success allowed). Never 5xx on drop — keep agents healthy.
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
    console.error('[otel-ingest]', message);
    return NextResponse.json(
      {
        partialSuccess: { rejectedDataPoints: 0 },
        har: { accepted: 0, dropped: 0, reasons: [message] },
      },
      { status: 200 },
    );
  }
}
