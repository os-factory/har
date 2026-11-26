import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OTLP ingest as a producer of the evidence timeline (ADR 0003): spans become
 * `workspace` / `observed` bindings and generation observations (Claude Code
 * included); Claude Code native `api_request` log events are dropped; trajectory
 * records are placed by evidence, else in the main checkout (agentId 0).
 */

const SLOT_2 = '/home/user/worktrees/project-abcd-har-agent-2-xyz';
const MAIN = '/home/user/project';
const SID = '7707de5f-74df-4df8-9376-e9fe20cd1f7b';

const state = vi.hoisted(() => ({
  bindings: [] as Array<{ repositoryId: string; bindings: Array<Record<string, unknown>>; origin: string }>,
  observations: [] as Array<{ repositoryId: string; observations: Array<Record<string, unknown>> }>,
  trajectory: [] as Array<Record<string, unknown>>,
  /** Stored bindings, by session: only their repository and time matter here. */
  placedBindings: [] as Array<{ sessionId: string; repositoryId: string; at: Date }>,
  /** Stored hook spans: `sessionKey` is a Resource `session.id` when one named the span. */
  spans: [] as Array<{ repositoryId: string; sessionKey: string; attributes: Record<string, string>; startTime: Date }>,
}));

const slot2 = {
  repositoryId: 'repo-1',
  slotId: 2,
  active: true,
  workDir: SLOT_2,
  worktreePath: SLOT_2,
  branch: 'main-abcd-har-agent-2-xyz',
  suffix: 'xyz',
  workUnitId: null,
  attemptId: null,
  occupancyKey: 'occ-2',
  sessionCreatedAt: null,
};

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findMany: async () => [{ id: 'repo-1', path: MAIN }],
      findUnique: async () => null,
    },
    agentSlot: {
      findMany: async () => [slot2],
      findUnique: async () => ({ purpose: 'set' }),
    },
    sessionSegment: {
      findMany: async () => [],
      findFirst: async ({ where, orderBy }: { where: { sessionId: string; from?: { lte: Date } }; orderBy?: Array<{ from: 'asc' | 'desc' }> }) => {
        const rows = state.placedBindings
          .filter((b) => b.sessionId === where.sessionId && (!where.from || b.at <= where.from.lte))
          .sort((a, b) => a.at.getTime() - b.at.getTime());
        return (orderBy?.[0]?.from === 'desc' ? rows.reverse() : rows)[0] ?? null;
      },
    },
    usageObservation: { findFirst: async () => null },
    attempt: { findMany: async () => [], findFirst: async () => null },
    // The span lookup by provider session: its values are the session id
    // (thrice), then the bound `at` of a latest-span query.
    $queryRaw: async (query: { sql: string; values: unknown[] }) => {
      const [sessionId] = query.values;
      const at = query.values.find((value): value is Date => value instanceof Date);
      const rows = state.spans
        .filter((span) => [span.sessionKey, span.attributes['otelhook.session.id'], span.attributes['session.id']].includes(sessionId as string))
        .filter((span) => !at || span.startTime <= at)
        .sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
      return (at ? rows.reverse() : rows).slice(0, 1).map((span) => ({ repositoryId: span.repositoryId }));
    },
  },
}));

vi.mock('@/server/session-attribution', () => ({
  recordBindings: async (repositoryId: string, bindings: Array<Record<string, unknown>>, origin: string) => {
    state.bindings.push({ repositoryId, bindings, origin });
    return { synced: bindings.length, created: bindings.length };
  },
  recordObservations: async (repositoryId: string, observations: Array<Record<string, unknown>>) => {
    state.observations.push({ repositoryId, observations });
    return { synced: observations.length, created: observations.length };
  },
}));

vi.mock('@/server/trajectory-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/trajectory-ledger')>()),
  appendTrajectoryRecord: async (_repositoryId: string, record: Record<string, unknown>) => {
    state.trajectory.push(record);
    return { record, inserted: true };
  },
}));

import { ingestOtelLogsJson, ingestOtelTracesJson } from './otel-ingest';

function attrs(map: Record<string, string | number>) {
  return Object.entries(map).map(([key, value]) => ({
    key,
    value: typeof value === 'number' ? { intValue: value } : { stringValue: value },
  }));
}

function traces(resource: Record<string, string>, spans: Array<{ name: string; spanId: string; attributes: Record<string, string | number> }>) {
  return {
    resourceSpans: [
      {
        resource: { attributes: attrs(resource) },
        scopeSpans: [
          {
            spans: spans.map((span) => ({
              traceId: 'a'.repeat(32),
              spanId: span.spanId,
              name: span.name,
              startTimeUnixNano: '1762941600000000000',
              endTimeUnixNano: '1762941630000000000',
              attributes: attrs(span.attributes),
            })),
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  state.bindings.length = 0;
  state.observations.length = 0;
  state.trajectory.length = 0;
  state.placedBindings.length = 0;
  state.spans.length = 0;
});

describe('ingestOtelTracesJson — evidence and usage', () => {
  it('records a workspace binding and a generation observation for a session running in a slot', async () => {
    const result = await ingestOtelTracesJson(
      traces({ 'otelhook.provider.id': 'cursor' }, [
        {
          name: 'generation gpt-5.5',
          spanId: '1'.repeat(16),
          attributes: {
            'gen_ai.client.workspace': SLOT_2,
            'otelhook.session.id': 'conv-1',
            'otelhook.generation.id': 'gen-1',
            'otelhook.usage.temporality': 'delta',
            'gen_ai.response.model': 'gpt-5.5',
            'gen_ai.usage.input_tokens': 100,
            'gen_ai.usage.output_tokens': 10,
          },
        },
      ]),
    );

    expect(result).toMatchObject({ accepted: 1, dropped: 0 });
    expect(state.bindings).toEqual([
      {
        repositoryId: 'repo-1',
        origin: 'otel',
        bindings: [expect.objectContaining({ agentTool: 'cursor', sessionId: 'conv-1', kind: 'workspace', slotId: 2, occupancyKey: 'occ-2' })],
      },
    ]);
    expect(state.observations[0].observations[0]).toMatchObject({
      sessionId: 'conv-1',
      observationKey: 'gen-1',
      producer: 'otelhook.generation',
      tokensInput: 100,
      tokensOutput: 10,
    });
    expect(state.trajectory[0]).toMatchObject({ agentId: 2 });
  });

  it('turns a tool event on a slot branch into an observed binding; no evidence means the main checkout', async () => {
    await ingestOtelTracesJson(
      traces({ 'otelhook.provider.id': 'claude-code' }, [
        {
          name: 'tool Edit',
          spanId: '2'.repeat(16),
          attributes: {
            'gen_ai.client.workspace': MAIN,
            'otelhook.session.id': SID,
            'otelhook.subagent.id': 'agent-7',
            'vcs.ref.head.name': 'main-abcd-har-agent-2-xyz',
            'otelhook.target.source': 'tool-path',
          },
        },
        {
          name: 'tool Read',
          spanId: '3'.repeat(16),
          attributes: { 'gen_ai.client.workspace': MAIN, 'otelhook.session.id': SID },
        },
      ]),
    );

    expect(state.bindings).toHaveLength(1);
    expect(state.bindings[0].bindings[0]).toMatchObject({
      agentTool: 'claude_code',
      sessionId: SID,
      subagentId: 'agent-7',
      kind: 'observed',
      slotId: 2,
      branch: 'main-abcd-har-agent-2-xyz',
    });
    expect(state.observations).toHaveLength(0);
    expect(state.trajectory.map((record) => record.agentId)).toEqual([2, 0]);
  });
});

describe('evidence time for a span exported when it ends', () => {
  const sessionSpan = {
    name: 'session.start',
    spanId: '4'.repeat(16),
    attributes: { 'gen_ai.client.workspace': SLOT_2, 'otelhook.session.id': SID },
  };

  it('records a span\'s cwd evidence at the span\'s end, not its start', async () => {
    await ingestOtelTracesJson(traces({ 'otelhook.provider.id': 'claude-code' }, [sessionSpan]));

    expect(state.bindings[0].bindings[0]).toMatchObject({ kind: 'workspace', slotId: 2 });
    expect((state.bindings[0].bindings[0].at as Date).toISOString()).toBe('2025-11-12T10:00:30.000Z');
  });

  it('takes no evidence from the span.* log event that mirrors a span at its start time', async () => {
    const logRecord = (name: string, spanId?: string) => ({
      timeUnixNano: '1762941600000000000',
      ...(spanId ? { spanId } : {}),
      attributes: attrs({ 'event.name': name, 'gen_ai.client.workspace': SLOT_2, 'otelhook.session.id': SID, 'otelhook.provider.id': 'claude-code' }),
    });
    await ingestOtelLogsJson({
      resourceLogs: [
        {
          resource: { attributes: attrs({ 'otelhook.provider.id': 'claude-code' }) },
          scopeLogs: [{ logRecords: [logRecord('span.session', '4'.repeat(16)), logRecord('tool.start')] }],
        },
      ],
    });

    expect(state.bindings).toHaveLength(1);
    expect(state.trajectory).toHaveLength(2);
  });
});

function apiRequests(requests: Array<{ requestId: string; timeUnixNano: string }>) {
  return {
    resourceLogs: [
      {
        resource: { attributes: attrs({ 'service.name': 'claude-code' }) },
        scopeLogs: [
          {
            logRecords: requests.map(({ requestId, timeUnixNano }) => ({
              timeUnixNano,
              body: { stringValue: 'claude_code.api_request' },
              attributes: attrs({
                'event.name': 'api_request',
                'session.id': SID,
                request_id: requestId,
                model: 'claude-opus-5-5',
                input_tokens: 5,
                output_tokens: 6,
              }),
            })),
          },
        ],
      },
    ],
  };
}

describe('Claude Code usage from otel-hook only (ADR 0005 section 5)', () => {
  it('drops native api_request events: no observation, no trajectory fact', async () => {
    state.placedBindings.push({ sessionId: SID, repositoryId: 'repo-1', at: new Date('2025-11-12T09:00:00Z') });
    const result = await ingestOtelLogsJson(apiRequests([{ requestId: 'req_1', timeUnixNano: '1762941600000000000' }]));

    expect(result).toMatchObject({ accepted: 0, dropped: 1 });
    expect(result.reasons[0]).toMatch(/otel-hook/);
    expect(state.observations).toHaveLength(0);
    expect(state.trajectory).toHaveLength(0);
  });

  it('books the turn and subagent generations of a Claude Code session, each once', async () => {
    const usage = (generationId: string, extra: Record<string, string | number> = {}) => ({
      'gen_ai.client.workspace': SLOT_2,
      'otelhook.session.id': SID,
      'otelhook.generation.id': generationId,
      'otelhook.usage.temporality': 'delta',
      'gen_ai.response.model': 'claude-opus-4-1',
      'gen_ai.usage.input_tokens': 1300,
      'gen_ai.usage.cache_read.input_tokens': 1000,
      'gen_ai.usage.cache_creation.input_tokens': 200,
      'gen_ai.usage.output_tokens': 50,
      ...extra,
    });
    const batch = traces({ 'otelhook.provider.id': 'claude-code' }, [
      { name: 'generation claude-opus-4-1', spanId: '1'.repeat(16), attributes: usage('gen-turn') },
      {
        name: 'generation claude-haiku-4-5',
        spanId: '2'.repeat(16),
        attributes: usage('gen-sub', { 'otelhook.subagent.id': 'agent-1', 'gen_ai.response.model': 'claude-haiku-4-5' }),
      },
    ]);
    const result = await ingestOtelTracesJson(batch);

    expect(result).toMatchObject({ accepted: 2, dropped: 0 });
    const booked = state.observations.flatMap((row) => row.observations);
    expect(booked).toEqual([
      expect.objectContaining({ agentTool: 'claude_code', sessionId: SID, observationKey: 'gen-turn', tokensInput: 100, tokensCacheRead: 1000, tokensCacheCreation: 200, tokensOutput: 50 }),
      expect.objectContaining({ agentTool: 'claude_code', sessionId: SID, subagentId: 'agent-1', observationKey: 'gen-sub', model: 'claude-haiku-4-5' }),
    ]);
    // Keyed by otelhook.generation.id: a repeated delivery is the same two facts.
    expect(new Set(booked.map((observation) => observation.observationKey)).size).toBe(2);
  });
});
