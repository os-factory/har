import { fetchPersistedTrajectory } from '../src/core/control-persisted-trajectory';

const API = 'http://localhost:3847';

function ledgerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'row-1',
    repositoryId: 'local-repo-1',
    version: 1,
    source: 'otel',
    sourceEventId: 'evt-1',
    contentKey: 'prompt',
    sessionKey: 'feat/x',
    agentId: 1,
    agentTool: 'claude_code',
    eventType: 'claude_code.user_prompt',
    sequence: 3,
    eventTimestamp: '2026-01-01T00:00:00.000Z',
    payload: { promptText: 'hi', attributes: {} },
    contentKind: 'prompt',
    contentDisclosure: 'withheld',
    contentLabel: null,
    toolCallId: 'call-1',
    traceId: null,
    createdAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function spanRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'span-row-1',
    sessionKey: 'feat/x',
    agentId: 1,
    agentTool: 'claude_code',
    traceId: 'trace-1',
    spanId: 'span-1',
    parentSpanId: null,
    name: 'tool.Read',
    startTime: '2026-01-01T00:00:00.000Z',
    endTime: null,
    attributes: { 'gen_ai.tool.name': 'Read' },
    createdAt: '2026-01-04T00:00:00.000Z',
    ...overrides,
  };
}

function mockControl(options: {
  repos?: { id: string; path: string }[];
  records?: Record<string, unknown>[];
  spans?: Record<string, unknown>[];
  trajectoryStatus?: number;
}): jest.Mock {
  const fn = jest.fn(async (url: string) => {
    const target = String(url);
    if (target.endsWith('/api/repos')) {
      return {
        ok: true,
        status: 200,
        json: async () => options.repos ?? [{ id: 'local-repo-1', path: '/repo/x' }],
      };
    }
    if (target.includes('/trajectory')) {
      const status = options.trajectoryStatus ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => ({ records: options.records ?? [] }),
      };
    }
    if (target.includes('/spans')) {
      return { ok: true, status: 200, json: async () => ({ spans: options.spans ?? [] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  (global as unknown as { fetch: unknown }).fetch = fn;
  return fn;
}

const BOTH = { records: { since: null }, spans: { since: null } } as const;

describe('fetchPersistedTrajectory', () => {
  it('maps a stored ledger row to the canonical record shape', async () => {
    mockControl({ records: [ledgerRow()] });

    const { records } = await fetchPersistedTrajectory('/repo/x', API, BOTH);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      version: 1,
      source: 'otel',
      sourceEventId: 'evt-1',
      contentKey: 'prompt',
      sequence: 3,
      // The DB column is eventTimestamp; the wire field is timestamp.
      timestamp: '2026-01-01T00:00:00.000Z',
      contentDisclosure: 'withheld',
      toolCallId: 'call-1',
    });
  });

  it('does not forward Mission Control storage identity', async () => {
    mockControl({ records: [ledgerRow()] });

    const { records } = await fetchPersistedTrajectory('/repo/x', API, BOTH);

    expect(records[0]).not.toHaveProperty('id');
    expect(records[0]).not.toHaveProperty('repositoryId');
    expect(records[0]).not.toHaveProperty('createdAt');
  });

  it('omits absent optional fields rather than sending null', async () => {
    mockControl({ records: [ledgerRow({ contentLabel: null, traceId: null })] });

    const { records } = await fetchPersistedTrajectory('/repo/x', API, BOTH);

    expect(records[0]).not.toHaveProperty('contentLabel');
    expect(records[0]).not.toHaveProperty('traceId');
  });

  it('watermarks records and spans on storage order, independently', async () => {
    mockControl({
      records: [
        ledgerRow({ sourceEventId: 'old', createdAt: '2026-01-01T00:00:00.000Z' }),
        ledgerRow({ sourceEventId: 'new', createdAt: '2026-01-05T00:00:00.000Z' }),
      ],
      spans: [spanRow()],
    });

    const result = await fetchPersistedTrajectory('/repo/x', API, {
      records: { since: '2026-01-02T00:00:00.000Z' },
      spans: { since: null },
    });

    expect(result.records.map((r) => r.sourceEventId)).toEqual(['new']);
    expect(result.recordsMaxSyncedAt).toBe('2026-01-05T00:00:00.000Z');
    expect(result.spansMaxSyncedAt).toBe('2026-01-04T00:00:00.000Z');
  });

  it('skips a malformed row without discarding the batch', async () => {
    mockControl({
      records: [ledgerRow({ agentTool: 'not_an_agent' }), ledgerRow({ sourceEventId: 'evt-2' })],
    });

    const { records } = await fetchPersistedTrajectory('/repo/x', API, BOTH);

    expect(records.map((r) => r.sourceEventId)).toEqual(['evt-2']);
  });

  it('requests only what the caller asked for', async () => {
    const fetchMock = mockControl({ spans: [spanRow()] });

    const result = await fetchPersistedTrajectory('/repo/x', API, {
      records: false,
      spans: { since: null },
    });

    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/trajectory'))).toBe(false);
    expect(result.records).toEqual([]);
    expect(result.spans).toHaveLength(1);
  });

  it('returns empty without calling control when nothing is requested', async () => {
    const fetchMock = mockControl({});

    const result = await fetchPersistedTrajectory('/repo/x', API, {
      records: false,
      spans: false,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      records: [],
      spans: [],
      recordsMaxSyncedAt: null,
      spansMaxSyncedAt: null,
      failures: [],
      truncated: [],
    });
  });

  it('returns empty when the repo is not registered with control', async () => {
    mockControl({ repos: [], records: [ledgerRow()] });

    const result = await fetchPersistedTrajectory('/repo/x', API, BOTH);

    expect(result.records).toEqual([]);
    expect(result.recordsMaxSyncedAt).toBeNull();
  });

  it('reports the failure instead of throwing when control is unreachable', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    await expect(fetchPersistedTrajectory('/repo/x', API, BOTH)).resolves.toEqual({
      records: [],
      spans: [],
      recordsMaxSyncedAt: null,
      spansMaxSyncedAt: null,
      failures: [{ channel: 'repos', reason: 'ECONNREFUSED' }],
      truncated: [],
    });
  });

  it('reports a failed channel without watermarking it, and keeps the other', async () => {
    mockControl({ records: [ledgerRow()], spans: [spanRow()], trajectoryStatus: 500 });

    const result = await fetchPersistedTrajectory('/repo/x', API, BOTH);

    expect(result.failures).toEqual([{ channel: 'trajectory', reason: 'HTTP 500' }]);
    expect(result.records).toEqual([]);
    expect(result.recordsMaxSyncedAt).toBeNull();
    expect(result.spans).toHaveLength(1);
    expect(result.spansMaxSyncedAt).toBe('2026-01-04T00:00:00.000Z');
  });

  it('passes the watermark to control instead of filtering a capped page locally', async () => {
    const fetchMock = mockControl({ spans: [spanRow()] });

    await fetchPersistedTrajectory('/repo/x', API, {
      records: false,
      spans: { since: '2026-01-03T00:00:00.000Z' },
    });

    const spansCall = fetchMock.mock.calls.map(([url]) => String(url)).find((url) => url.includes('/spans'));
    expect(spansCall).toContain('since=2026-01-03T00%3A00%3A00.000Z');
    expect(spansCall).toContain('limit=');
  });

  it('walks spans forward page by page on a (createdAt, id) cursor', async () => {
    process.env.HAR_CONTROL_READ_PAGE_SIZE = '2';
    const pages = [
      [
        spanRow({ id: 's1', spanId: 'span-1', createdAt: '2026-01-01T00:00:00.000Z' }),
        spanRow({ id: 's2', spanId: 'span-2', createdAt: '2026-01-01T00:00:00.000Z' }),
      ],
      [spanRow({ id: 's3', spanId: 'span-3', createdAt: '2026-01-02T00:00:00.000Z' })],
    ];
    const fetchMock = jest.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/api/repos') && !target.includes('/spans')) {
        return { ok: true, status: 200, json: async () => [{ id: 'local-repo-1', path: '/repo/x' }] };
      }
      return { ok: true, status: 200, json: async () => ({ spans: pages.shift() ?? [] }) };
    });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    try {
      const result = await fetchPersistedTrajectory('/repo/x', API, {
        records: false,
        spans: { since: null },
      });

      expect(result.spans.map((span) => span.spanId)).toEqual(['span-1', 'span-2', 'span-3']);
      expect(result.truncated).toEqual([]);
      expect(result.spansMaxSyncedAt).toBe('2026-01-02T00:00:00.000Z');
      const second = fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes('/spans'))[1];
      expect(second).toContain('since=2026-01-01T00%3A00%3A00.000Z');
      expect(second).toContain('sinceId=s2');
    } finally {
      delete process.env.HAR_CONTROL_READ_PAGE_SIZE;
    }
  });

  it('reports truncation when the page cap is reached with rows pending', async () => {
    process.env.HAR_CONTROL_READ_PAGE_SIZE = '1';
    let issued = 0;
    const fetchMock = jest.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/api/repos') && !target.includes('/spans')) {
        return { ok: true, status: 200, json: async () => [{ id: 'local-repo-1', path: '/repo/x' }] };
      }
      issued += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          spans: [
            spanRow({
              id: `s${issued}`,
              spanId: `span-${issued}`,
              createdAt: new Date(Date.UTC(2026, 0, issued)).toISOString(),
            }),
          ],
        }),
      };
    });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    try {
      const result = await fetchPersistedTrajectory('/repo/x', API, {
        records: false,
        spans: { since: null },
      });

      expect(result.spans).toHaveLength(20);
      expect(result.truncated).toEqual(['spans']);
      expect(result.spansMaxSyncedAt).toBe('2026-01-20T00:00:00.000Z');
    } finally {
      delete process.env.HAR_CONTROL_READ_PAGE_SIZE;
    }
  });

  it('stops instead of looping when control ignores the cursor', async () => {
    process.env.HAR_CONTROL_READ_PAGE_SIZE = '1';
    const fetchMock = jest.fn(async (url: string) => {
      const target = String(url);
      if (target.includes('/api/repos') && !target.includes('/spans')) {
        return { ok: true, status: 200, json: async () => [{ id: 'local-repo-1', path: '/repo/x' }] };
      }
      return { ok: true, status: 200, json: async () => ({ spans: [spanRow()] }) };
    });
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    try {
      const result = await fetchPersistedTrajectory('/repo/x', API, {
        records: false,
        spans: { since: null },
      });

      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/spans'))).toHaveLength(2);
      expect(result.truncated).toEqual([]);
    } finally {
      delete process.env.HAR_CONTROL_READ_PAGE_SIZE;
    }
  });

  it('drops null span fields rather than forwarding them', async () => {
    mockControl({ spans: [spanRow({ parentSpanId: null, endTime: null })] });

    const { spans } = await fetchPersistedTrajectory('/repo/x', API, BOTH);

    expect(spans[0]).not.toHaveProperty('parentSpanId');
    expect(spans[0]).not.toHaveProperty('endTime');
    expect(spans[0].attributes).toEqual({ 'gen_ai.tool.name': 'Read' });
  });
});
