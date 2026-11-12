import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shape of Claude Code 2.1.x native metrics (CLAUDE_CODE_ENABLE_TELEMETRY=1):
// `session.id` and `model` on every data point, no workspace on the resource.
// Values are synthetic.

interface FakeSpan {
  id: string;
  repositoryId: string;
  sessionKey: string;
  agentId: number;
  workUnitId: string | null;
  attemptId: string | null;
  sessionId: string;
}

let spans: FakeSpan[] = [];
const upserts: Array<{ repositoryId: string; usage: Record<string, unknown> }> = [];

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
    agentSessionEvent: { findFirst: vi.fn(async () => null) },
    agentSessionSpan: {
      findFirst: vi.fn(
        async ({ where }: { where: { sessionKey: string } }) =>
          spans.find((s) => s.sessionKey === where.sessionKey) ?? null,
      ),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          spans.find((s) => s.id === where.id) ?? null,
      ),
    },
    agentSlot: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: { repositoryId_slotId: { repositoryId: string; slotId: number } };
        }) =>
          where.repositoryId_slotId.slotId === 2
            ? {
                workDir: '/worktrees/main-abcd-har-agent-2-xy12',
                worktreePath: '/worktrees/main-abcd-har-agent-2-xy12',
                branch: 'main-abcd-har-agent-2-xy12',
                suffix: 'xy12',
                occupancyKey: 'occ-2',
              }
            : null,
      ),
    },
    // json_extract fallback: the template's last value is the session id.
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, sessionId: string) =>
      spans.filter((s) => s.sessionId === sessionId).map((s) => ({ id: s.id })),
    ),
  },
}));

vi.mock('@/server/usage', () => ({
  upsertSessionUsage: vi.fn(async (repositoryId: string, usage: Record<string, unknown>) => {
    upserts.push({ repositoryId, usage });
  }),
}));

import { ingestOtelMetricsJson } from './otel-ingest';

function attr(key: string, value: string | number) {
  return {
    key,
    value: typeof value === 'number' ? { doubleValue: value } : { stringValue: value },
  };
}

function claudeMetrics(sessionId: string) {
  const base = [attr('session.id', sessionId), attr('model', 'claude-opus-5-5')];
  const token = (type: string, value: number) => ({
    asDouble: value,
    attributes: [...base, attr('type', type)],
  });
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: [attr('service.name', 'claude-code'), attr('service.version', '2.1.322')],
        },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.token.usage',
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: [
                    token('input', 10),
                    token('output', 20),
                    token('cacheRead', 300),
                    token('cacheCreation', 40),
                  ],
                },
              },
              {
                name: 'claude_code.cost.usage',
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: [{ asDouble: 0.25, attributes: base }],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

beforeEach(() => {
  spans = [];
  upserts.length = 0;
});

describe('ingestOtelMetricsJson — Claude Code native metrics', () => {
  it('attributes a session to the slot its hook spans were attributed to', async () => {
    const sid = '7707de5f-74df-4df8-9376-e9fe20cd1f7b';
    spans = [
      {
        id: 's1',
        repositoryId: 'repo-1',
        sessionKey: sid,
        agentId: 2,
        workUnitId: 'wu-1',
        attemptId: null,
        sessionId: sid,
      },
    ];

    const result = await ingestOtelMetricsJson(claudeMetrics(sid));

    expect(result).toMatchObject({ accepted: 1, dropped: 0 });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].repositoryId).toBe('repo-1');
    expect(upserts[0].usage).toMatchObject({
      sessionKey: sid,
      agentId: 2,
      agentTool: 'claude_code',
      workDir: '/worktrees/main-abcd-har-agent-2-xy12',
      branch: 'main-abcd-har-agent-2-xy12',
      workUnitId: 'wu-1',
      tokensInput: 10,
      tokensOutput: 20,
      tokensCacheRead: 300,
      tokensCacheCreation: 40,
      tokensTotal: 370,
      costUsd: 0.25,
      sources: ['otel'],
      modelBreakdown: {
        'claude-opus-5-5': {
          tokensInput: 10,
          tokensOutput: 20,
          tokensCacheRead: 300,
          tokensCacheCreation: 40,
          tokensTotal: 370,
        },
      },
    });
  });

  it('finds the session through span attributes when its sessionKey is a slot branch', async () => {
    const sid = '43cd320d-812b-4884-b52f-a6f396ea6829';
    spans = [
      {
        id: 's2',
        repositoryId: 'repo-1',
        sessionKey: 'main-abcd-har-agent-2-xy12',
        agentId: 2,
        workUnitId: null,
        attemptId: null,
        sessionId: sid,
      },
    ];

    const result = await ingestOtelMetricsJson(claudeMetrics(sid));

    expect(result.accepted).toBe(1);
    expect(upserts[0].usage).toMatchObject({
      sessionKey: 'main-abcd-har-agent-2-xy12',
      agentId: 2,
    });
  });

  it('drops a session no hook span has been seen for yet', async () => {
    const result = await ingestOtelMetricsJson(
      claudeMetrics('aaaaaaaa-0000-4000-8000-000000000000'),
    );
    expect(result.accepted).toBe(0);
    expect(result.dropped).toBe(1);
    expect(upserts).toHaveLength(0);
  });
});
