/**
 * Pure OTLP / hooks mapping helpers mirrored for unit tests without Prisma.
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

function detectAgentTool(resource: Record<string, string | number | boolean>): string | null {
  const candidates = [
    String(resource['har.agent_tool'] ?? ''),
    String(resource['gen_ai.client.name'] ?? ''),
    String(resource['service.name'] ?? ''),
  ]
    .map((v) => v.toLowerCase().trim())
    .filter(Boolean);

  for (const value of candidates) {
    if (value === 'cursor' || value.includes('cursor')) return 'cursor';
    if (value === 'codex' || value.includes('codex')) return 'codex';
    if (
      value === 'claude' ||
      value === 'claude_code' ||
      value === 'claude-code' ||
      value.includes('claude')
    ) {
      return 'claude_code';
    }
  }
  return null;
}

function applyHooksUsageFromAttrs(attributes: Record<string, string | number | boolean>): {
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
} {
  const usage = {
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
  };
  const input = Number(
    attributes['gen_ai.usage.input_tokens'] ?? attributes['gen_ai.usage.prompt_tokens'] ?? 0,
  );
  const output = Number(
    attributes['gen_ai.usage.output_tokens'] ?? attributes['gen_ai.usage.completion_tokens'] ?? 0,
  );
  const cacheRead = Number(attributes['gen_ai.usage.cache_read.input_tokens'] ?? 0);
  const cacheCreate = Number(attributes['gen_ai.usage.cache_creation.input_tokens'] ?? 0);
  if (Number.isFinite(input) && input > 0) usage.tokensInput += input;
  if (Number.isFinite(output) && output > 0) usage.tokensOutput += output;
  if (Number.isFinite(cacheRead) && cacheRead > 0) usage.tokensCacheRead += cacheRead;
  if (Number.isFinite(cacheCreate) && cacheCreate > 0) usage.tokensCacheCreation += cacheCreate;
  return usage;
}

function extractPromptText(
  attributes: Record<string, string | number | boolean>,
  eventName?: string,
): string | null {
  for (const key of ['gen_ai.prompt.0.content', 'gen_ai.prompt', 'user.prompt', 'prompt']) {
    const value = attributes[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const hookEvent = String(attributes['gen_ai.client.hook.event'] ?? eventName ?? '').toLowerCase();
  if (hookEvent.includes('userprompt') || hookEvent.includes('beforesubmitprompt')) {
    return typeof attributes.prompt === 'string' ? attributes.prompt : null;
  }
  return null;
}

function truncatePurpose(prompt: string, max = 160): string {
  return prompt.length > max ? `${prompt.slice(0, max - 1)}…` : prompt;
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

describe('hooks agent tool + usage mapping', () => {
  it('detects cursor, claude, and codex from gen_ai.client.name', () => {
    expect(detectAgentTool({ 'gen_ai.client.name': 'cursor' })).toBe('cursor');
    expect(detectAgentTool({ 'gen_ai.client.name': 'claude' })).toBe('claude_code');
    expect(detectAgentTool({ 'gen_ai.client.name': 'codex' })).toBe('codex');
    expect(detectAgentTool({ 'service.name': 'har-ide-agent' })).toBeNull();
  });

  it('folds gen_ai.usage.* span attributes into token counters', () => {
    expect(
      applyHooksUsageFromAttrs({
        'gen_ai.usage.input_tokens': 1200,
        'gen_ai.usage.output_tokens': 340,
        'gen_ai.usage.cache_read.input_tokens': 50,
      }),
    ).toEqual({
      tokensInput: 1200,
      tokensOutput: 340,
      tokensCacheRead: 50,
      tokensCacheCreation: 0,
    });
  });

  it('derives truncated purpose from first prompt content', () => {
    const prompt = extractPromptText({
      'gen_ai.client.hook.event': 'UserPromptSubmit',
      'gen_ai.prompt.0.content': 'Fix the flaky telemetry tests in Mission Control',
    });
    expect(prompt).toContain('Fix the flaky');
    expect(truncatePurpose('x'.repeat(200)).length).toBe(160);
    expect(truncatePurpose('x'.repeat(200)).endsWith('…')).toBe(true);
  });
});
