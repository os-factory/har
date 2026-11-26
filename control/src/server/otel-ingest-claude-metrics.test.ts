import { beforeEach, describe, expect, it, vi } from 'vitest';

// Claude Code's own metrics (`claude_code.token.usage`, `claude_code.cost.usage`,
// turned on by HAR before 2.0) are not booked: Claude Code usage comes from
// otel-hook only (ADR 0005 section 5). otel-hook's metrics for Claude Code are
// kept like every other provider's, latest value per series.

const stored = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock('@/lib/db', () => ({
  prisma: {
    metricSeries: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        stored.push(data);
        return data;
      }),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('@/server/session-attribution', () => ({
  recordBindings: vi.fn(),
  recordObservations: vi.fn(),
}));

import { ingestOtelMetricsJson } from './otel-ingest';

function attr(key: string, value: string | number) {
  return { key, value: typeof value === 'number' ? { doubleValue: value } : { stringValue: value } };
}

function metrics(resource: Array<ReturnType<typeof attr>>, name: string, points: Array<Array<ReturnType<typeof attr>>>) {
  return {
    resourceMetrics: [
      {
        resource: { attributes: resource },
        scopeMetrics: [
          {
            metrics: [
              {
                name,
                sum: {
                  aggregationTemporality: 2,
                  dataPoints: points.map((attributes, index) => ({
                    attributes,
                    asDouble: 100 + index,
                    timeUnixNano: '1762941600000000000',
                  })),
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
  stored.length = 0;
});

describe('ingestOtelMetricsJson — Claude Code', () => {
  it('drops Claude Code native metrics: they are not a usage source any more', async () => {
    const result = await ingestOtelMetricsJson(
      metrics([attr('service.name', 'claude-code')], 'claude_code.token.usage', [
        [attr('session.id', 's-1'), attr('type', 'input'), attr('model', 'claude-opus-5-5')],
      ]),
    );
    expect(result).toMatchObject({ accepted: 0, dropped: 1 });
    expect(result.reasons[0]).toMatch(/native metrics from claude_code are not booked/);
    expect(stored).toHaveLength(0);
  });

  it('keeps otel-hook token metrics for Claude Code, one series per token type', async () => {
    const result = await ingestOtelMetricsJson(
      metrics([attr('otelhook.provider.id', 'claude-code'), attr('factory.attempt.id', 'att-1')], 'gen_ai.client.token.usage', [
        [attr('session.id', 's-1'), attr('gen_ai.token.type', 'input')],
        [attr('session.id', 's-1'), attr('gen_ai.token.type', 'output')],
      ]),
    );
    expect(result).toMatchObject({ accepted: 2, dropped: 0 });
    expect(stored.map((row) => [row.providerId, row.attemptId, row.sessionId])).toEqual([
      ['claude-code', 'att-1', 's-1'],
      ['claude-code', 'att-1', 's-1'],
    ]);
  });
});
