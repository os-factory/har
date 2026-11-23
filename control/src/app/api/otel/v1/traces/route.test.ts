import { beforeEach, describe, expect, it, vi } from 'vitest';

const forward = vi.hoisted(() => ({ calls: 0 }));

vi.mock('@/server/otel-ingest', () => ({
  ingestOtelTracesBody: async () => ({ accepted: 1, dropped: 0, reasons: [] }),
}));
vi.mock('@/server/otlp-forward', () => ({
  scheduleOtlpForward: () => {
    forward.calls += 1;
  },
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
  beforeEach(() => {
    forward.calls = 0;
  });

  it('ingests and forwards', async () => {
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(forward.calls).toBe(1);
  });

  it('ingests without forwarding when the sender already delivered to the destinations', async () => {
    const response = await POST(request({ 'x-har-otlp-forward': 'skip' }));
    expect(response.status).toBe(200);
    expect((await response.json()).har.accepted).toBe(1);
    expect(forward.calls).toBe(0);
  });
});
