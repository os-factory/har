import type { AgentSessionEvent, AgentSessionUsage } from '../src/harness/schema';
import { dedupePortalEvents, mergePortalUsage } from '../src/core/portal-usage-merge';

function usage(overrides: Partial<AgentSessionUsage> = {}): AgentSessionUsage {
  return {
    sessionKey: 'feat/x',
    agentId: 1,
    agentTool: 'claude_code',
    tokensInput: 0,
    tokensOutput: 0,
    tokensCacheRead: 0,
    tokensCacheCreation: 0,
    tokensTotal: 0,
    sources: [],
    harvestVersion: 0,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function event(overrides: Partial<AgentSessionEvent> = {}): AgentSessionEvent {
  return {
    sessionKey: 'feat/x',
    agentId: 1,
    agentTool: 'claude_code',
    eventName: 'claude_code.user_prompt',
    sequence: 1,
    timestamp: '2026-01-01T00:00:00.000Z',
    source: 'harvest',
    ...overrides,
  };
}

describe('mergePortalUsage', () => {
  it('passes live-only rows through untouched', () => {
    const live = [usage({ tokensTotal: 100 })];
    const merged = mergePortalUsage(live, []);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(live[0]);
  });

  it('passes persisted-only rows through untouched (torn-down slot)', () => {
    const persisted = [usage({ sessionKey: 'feat/gone', tokensTotal: 4200 })];
    const merged = mergePortalUsage([], persisted);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toBe(persisted[0]);
  });

  it('does not duplicate an overlapping (sessionKey, agentTool) key', () => {
    const merged = mergePortalUsage(
      [usage({ tokensTotal: 100 })],
      [usage({ tokensTotal: 250 })],
    );
    expect(merged).toHaveLength(1);
  });

  it('max-merges cumulative counters and unions sources on overlap', () => {
    const merged = mergePortalUsage(
      [usage({ tokensInput: 60, tokensTotal: 100, sources: ['harvest'] })],
      [
        usage({
          tokensInput: 40,
          tokensTotal: 250,
          sources: ['otel'],
          lastSeenAt: '2026-01-03T00:00:00.000Z',
        }),
      ],
    );
    expect(merged[0].tokensInput).toBe(60);
    expect(merged[0].tokensTotal).toBe(250);
    expect(merged[0].sources.sort()).toEqual(['harvest', 'otel']);
    expect(merged[0].firstSeenAt).toBe('2026-01-01T00:00:00.000Z');
    expect(merged[0].lastSeenAt).toBe('2026-01-03T00:00:00.000Z');
  });

  it('keeps distinct rows for the same session but different agent tools', () => {
    const merged = mergePortalUsage(
      [usage({ agentTool: 'claude_code' })],
      [usage({ agentTool: 'codex' })],
    );
    expect(merged).toHaveLength(2);
  });

  it('merges model breakdowns per model with max token fields', () => {
    const merged = mergePortalUsage(
      [
        usage({
          modelBreakdown: {
            'claude-opus-4-8': { tokensInput: 60, tokensTotal: 100 },
          },
        }),
      ],
      [
        usage({
          modelBreakdown: {
            'claude-opus-4-8': { tokensInput: 40, tokensTotal: 250 },
            'claude-haiku': { tokensTotal: 10 },
          },
        }),
      ],
    );
    expect(merged[0].modelBreakdown).toEqual({
      'claude-opus-4-8': { tokensInput: 60, tokensTotal: 250 },
      'claude-haiku': { tokensTotal: 10 },
    });
  });

  it('takes the max non-null cost across sources', () => {
    const merged = mergePortalUsage(
      [usage({ costUsd: null })],
      [usage({ costUsd: 1.25 })],
    );
    expect(merged[0].costUsd).toBe(1.25);
  });

  it('lets a newer harvest lower a persisted pre-dedupe row', () => {
    const merged = mergePortalUsage(
      [
        usage({
          tokensInput: 50,
          tokensTotal: 100,
          costUsd: 1.1,
          modelBreakdown: { 'claude-opus-5': { tokensTotal: 100 } },
          sources: ['harvest'],
          harvestVersion: 1,
        }),
      ],
      [
        usage({
          tokensInput: 100,
          tokensTotal: 200,
          costUsd: 2.2,
          modelBreakdown: { 'claude-opus-5': { tokensTotal: 200 } },
          sources: ['harvest'],
          harvestVersion: 0,
        }),
      ],
    );
    expect(merged[0].tokensInput).toBe(50);
    expect(merged[0].tokensTotal).toBe(100);
    expect(merged[0].costUsd).toBe(1.1);
    expect(merged[0].modelBreakdown).toEqual({ 'claude-opus-5': { tokensTotal: 100 } });
    expect(merged[0].harvestVersion).toBe(1);
  });

  it('still refuses to lower a row at the same harvest version', () => {
    const merged = mergePortalUsage(
      [usage({ tokensTotal: 100, sources: ['harvest'], harvestVersion: 1 })],
      [usage({ tokensTotal: 200, sources: ['harvest'], harvestVersion: 1 })],
    );
    expect(merged[0].tokensTotal).toBe(200);
    expect(merged[0].harvestVersion).toBe(1);
  });

  it('max-merges instead of replacing when OTLP contributed to the row', () => {
    const merged = mergePortalUsage(
      [usage({ tokensTotal: 100, sources: ['harvest'], harvestVersion: 1 })],
      [usage({ tokensTotal: 200, sources: ['harvest', 'otel'], harvestVersion: 0 })],
    );
    expect(merged[0].tokensTotal).toBe(200);
    expect(merged[0].harvestVersion).toBe(0);
  });
});

describe('dedupePortalEvents', () => {
  it('dedupes on (sessionKey, agentTool, eventName, sequence), live wins', () => {
    const live = [event({ promptText: 'live' })];
    const persisted = [event({ promptText: 'persisted' })];
    const merged = dedupePortalEvents(live, persisted);
    expect(merged).toHaveLength(1);
    expect(merged[0].promptText).toBe('live');
  });

  it('keeps events that differ by sequence', () => {
    const merged = dedupePortalEvents(
      [event({ sequence: 1 })],
      [event({ sequence: 2 })],
    );
    expect(merged).toHaveLength(2);
  });

  it('returns persisted-only events when there is no live harvest', () => {
    const persisted = [event({ sessionKey: 'feat/gone' })];
    expect(dedupePortalEvents([], persisted)).toEqual(persisted);
  });
});
