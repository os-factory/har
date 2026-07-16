/**
 * Pure OTLP JSON parsing helpers mirrored for unit tests without Prisma.
 * Keeps control ingest logic covered from the har package test suite.
 */

function attrsFromOtel(list: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const key = String((item as { key?: string }).key ?? '');
    if (!key) continue;
    const value = (item as { value?: Record<string, unknown> }).value ?? {};
    if (typeof value.stringValue === 'string') out[key] = value.stringValue;
    else if (typeof value.intValue === 'number' || typeof value.intValue === 'string') {
      out[key] = Number(value.intValue);
    } else if (typeof value.doubleValue === 'number') out[key] = value.doubleValue;
  }
  return out;
}

function extractClaudeTotals(payload: unknown): {
  sessionKey: string;
  tokensInput: number;
  tokensOutput: number;
  costUsd: number;
} | null {
  const root = payload as { resourceMetrics?: unknown[] };
  const rm = root.resourceMetrics?.[0] as
    | { resource?: { attributes?: unknown }; scopeMetrics?: unknown[] }
    | undefined;
  if (!rm) return null;
  const resource = attrsFromOtel(rm.resource?.attributes);
  const sessionKey = String(resource['har.session_key'] ?? '');
  let tokensInput = 0;
  let tokensOutput = 0;
  let costUsd = 0;
  for (const sm of rm.scopeMetrics ?? []) {
    const metrics = (sm as { metrics?: unknown[] }).metrics ?? [];
    for (const metric of metrics) {
      const name = String((metric as { name?: string }).name ?? '');
      const dataPoints =
        (metric as { sum?: { dataPoints?: unknown[] } }).sum?.dataPoints ?? [];
      for (const dp of dataPoints) {
        const point = dp as {
          attributes?: unknown;
          asDouble?: number;
          asInt?: number;
        };
        const attrs = attrsFromOtel(point.attributes);
        const value = point.asDouble ?? Number(point.asInt ?? 0);
        if (name === 'claude_code.token.usage') {
          if (attrs.type === 'input') tokensInput += value;
          if (attrs.type === 'output') tokensOutput += value;
        }
        if (name === 'claude_code.cost.usage') costUsd += value;
      }
    }
  }
  return { sessionKey, tokensInput, tokensOutput, costUsd };
}

function maxMerge(
  a: { tokens: number; cost: number | null },
  b: { tokens: number; cost: number | null },
): { tokens: number; cost: number | null } {
  const cost =
    a.cost == null && b.cost == null
      ? null
      : Math.max(a.cost ?? 0, b.cost ?? 0);
  return { tokens: Math.max(a.tokens, b.tokens), cost };
}

describe('otel metric mapping', () => {
  it('reads Claude token and cost metrics from OTLP JSON', () => {
    const payload = {
      resourceMetrics: [
        {
          resource: {
            attributes: [
              { key: 'har.session_key', value: { stringValue: 'main-abcd-har-agent-1-xy12' } },
              { key: 'har.repo_path', value: { stringValue: '/repo' } },
              { key: 'har.agent_id', value: { intValue: 1 } },
              { key: 'service.name', value: { stringValue: 'claude-code' } },
            ],
          },
          scopeMetrics: [
            {
              metrics: [
                {
                  name: 'claude_code.token.usage',
                  sum: {
                    dataPoints: [
                      {
                        attributes: [{ key: 'type', value: { stringValue: 'input' } }],
                        asDouble: 1000,
                      },
                      {
                        attributes: [{ key: 'type', value: { stringValue: 'output' } }],
                        asDouble: 200,
                      },
                    ],
                  },
                },
                {
                  name: 'claude_code.cost.usage',
                  sum: { dataPoints: [{ asDouble: 0.12 }] },
                },
              ],
            },
          ],
        },
      ],
    };

    const totals = extractClaudeTotals(payload);
    expect(totals).toEqual({
      sessionKey: 'main-abcd-har-agent-1-xy12',
      tokensInput: 1000,
      tokensOutput: 200,
      costUsd: 0.12,
    });
  });

  it('max-merges otel and harvest counters', () => {
    expect(
      maxMerge({ tokens: 100, cost: 0.1 }, { tokens: 150, cost: 0.05 }),
    ).toEqual({ tokens: 150, cost: 0.1 });
    expect(maxMerge({ tokens: 10, cost: null }, { tokens: 5, cost: null })).toEqual({
      tokens: 10,
      cost: null,
    });
  });
});
