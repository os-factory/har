import { describe, expect, it, vi } from 'vitest';

vi.mock('@/server/otel-ingest', () => ({
  ingestOtelTracesBody: async () => ({ accepted: 1, dropped: 0, reasons: [] }),
  ingestOtelMetricsBody: async () => ({ accepted: 1, dropped: 0, reasons: [] }),
  ingestOtelLogsBody: async () => ({ accepted: 1, dropped: 0, reasons: [] }),
}));

import { POST } from './route';

function request(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3847/api/otel/v1/traces', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{"resourceSpans":[]}',
  });
}

describe('POST /api/otel/v1/traces', () => {
  it('ingests', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect((await response.json()).har.accepted).toBe(1);
  });

  it('stores a payload sent with the skip-forward header (the CLI sends it for older Mission Controls)', async () => {
    // Mission Control forwards nothing any more; the header is ignored.
    const response = await POST(request({ 'x-har-otlp-forward': 'skip' }));
    expect(response.status).toBe(200);
    expect((await response.json()).har.accepted).toBe(1);
  });
});
