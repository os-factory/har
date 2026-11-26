import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ prisma: {} }));

import {
  codexSseObservation,
  isClaudeNativeUsageRecord,
  isUsageOnlyLogRecord,
  otelHookGenerationObservation,
  providerSessionRef,
  type OtelLogLike,
  type OtelSpanLike,
} from './otel-attribution';

const SID = '7707de5f-74df-4df8-9376-e9fe20cd1f7b';
const AT = new Date('2026-11-12T10:00:00.000Z');

function log(eventName: string, attributes: OtelLogLike['attributes'], bodyText: string | null = null): OtelLogLike {
  return { eventName, bodyText, attributes, resource: { 'service.name': 'claude-code' }, timestamp: AT };
}

describe('providerSessionRef', () => {
  it('prefers the provider id otel-hook keeps beside a HAR session key', () => {
    expect(
      providerSessionRef('cursor', { 'session.id': 'har-key', 'otelhook.session.id': 'conv-1', 'otelhook.subagent.id': 'sub-1' }),
    ).toEqual({ agentTool: 'cursor', sessionId: 'conv-1', subagentId: 'sub-1' });
  });

  it('reads Claude Code native `session.id` and subagent `agent_id`', () => {
    expect(providerSessionRef('claude_code', { 'session.id': SID, agent_id: 'a-1' })).toEqual({
      agentTool: 'claude_code',
      sessionId: SID,
      subagentId: 'a-1',
    });
  });

  it('returns null without a session id', () => {
    expect(providerSessionRef('codex', { model: 'x' })).toBeNull();
  });
});

describe('isClaudeNativeUsageRecord', () => {
  it('recognizes Claude Code native api_request events, which are never booked', () => {
    const attrs = { 'event.name': 'api_request', 'session.id': SID, input_tokens: 12, request_id: 'req_1' };
    expect(isClaudeNativeUsageRecord(log('api_request', attrs, 'claude_code.api_request'))).toBe(true);
    expect(isClaudeNativeUsageRecord(log('claude_code.api_request', attrs))).toBe(true);
    // Not a usage observation either: it is dropped, not booked.
    expect(isUsageOnlyLogRecord(log('api_request', attrs, 'claude_code.api_request'))).toBe(false);
    expect(isClaudeNativeUsageRecord(log('user_prompt', { 'event.name': 'user_prompt' }, 'claude_code.user_prompt'))).toBe(false);
  });
});

describe('codexSseObservation', () => {
  it('splits cached input out of the inclusive input count', () => {
    const record: OtelLogLike = {
      eventName: 'codex.sse_event',
      bodyText: null,
      attributes: {
        'event.kind': 'response.completed',
        'conversation.id': 'thread-1',
        model: 'gpt-5.5-codex',
        input_token_count: 1000,
        cached_token_count: 800,
        output_token_count: 50,
        reasoning_token_count: 20,
      },
      resource: { 'service.name': 'codex_cli_rs' },
      timestamp: AT,
    };
    expect(isUsageOnlyLogRecord(record)).toBe(true);
    expect(codexSseObservation(record)).toMatchObject({
      agentTool: 'codex',
      sessionId: 'thread-1',
      granularity: 'request',
      producer: 'codex.sse_event',
      model: 'gpt-5.5-codex',
      tokensInput: 200,
      tokensCacheRead: 800,
      tokensOutput: 50,
      costUsd: null,
    });
  });

  it('ignores stream events that are not a completed response', () => {
    const record: OtelLogLike = {
      eventName: 'codex.sse_event',
      bodyText: null,
      attributes: { 'event.kind': 'response.output_text.delta', 'conversation.id': 'thread-1' },
      resource: {},
      timestamp: AT,
    };
    expect(isUsageOnlyLogRecord(record)).toBe(false);
    expect(codexSseObservation(record)).toBeNull();
  });
});

function span(name: string, attributes: OtelSpanLike['attributes']): OtelSpanLike {
  return {
    name,
    traceId: 'a'.repeat(32),
    spanId: 'b'.repeat(16),
    startTime: AT,
    endTime: new Date('2026-11-12T10:00:30.000Z'),
    attributes,
    resource: {},
  };
}

describe('otelHookGenerationObservation', () => {
  const usage = {
    'otelhook.session.id': 'conv-1',
    'otelhook.generation.id': 'gen-42',
    'otelhook.usage.temporality': 'delta',
    'gen_ai.response.model': 'claude-4.5-sonnet',
    'gen_ai.usage.input_tokens': 1000,
    'gen_ai.usage.cache_read.input_tokens': 600,
    'gen_ai.usage.cache_creation.input_tokens': 0,
    'gen_ai.usage.output_tokens': 70,
    'otelhook.subagent.id': 'sub-2',
  };

  it('maps a Cursor generation to one observation keyed by its generation id', () => {
    expect(otelHookGenerationObservation(span('generation claude-4.5-sonnet', usage), 'cursor')).toEqual({
      agentTool: 'cursor',
      sessionId: 'conv-1',
      subagentId: 'sub-2',
      observationKey: 'gen-42',
      observedAt: new Date('2026-11-12T10:00:30.000Z'),
      granularity: 'generation',
      source: 'otel',
      producer: 'otelhook.generation',
      model: 'claude-4.5-sonnet',
      tokensInput: 400,
      tokensOutput: 70,
      tokensCacheRead: 600,
      tokensCacheCreation: 0,
      costUsd: null,
    });
  });

  it('keys a Codex turn by turn id and reports the session running total', () => {
    const observation = otelHookGenerationObservation(
      span('generation', { ...usage, 'otelhook.generation.id': 'turn-7', 'otelhook.usage.temporality': 'cumulative' }),
      'codex',
    );
    expect(observation).toMatchObject({
      observationKey: 'turn-7',
      granularity: 'turn',
      runningTotal: { tokensInput: 400, tokensOutput: 70, tokensCacheRead: 600, tokensCacheCreation: 0 },
    });
  });

  it('falls back to a span-keyed stream of its own without a generation id', () => {
    const legacy: Record<string, string | number> = { ...usage };
    delete legacy['otelhook.generation.id'];
    delete legacy['otelhook.usage.temporality'];
    expect(otelHookGenerationObservation(span('generation', legacy), 'codex')).toMatchObject({
      observationKey: `otelhook-generation:${'b'.repeat(16)}`,
      producer: 'otelhook.generation-span',
      runningTotal: expect.any(Object),
    });
    expect(otelHookGenerationObservation(span('generation', legacy), 'cursor')).not.toHaveProperty('runningTotal');
  });

  it('books Claude Code turn and subagent generations, delta, fresh input without cache (ADR 0005 section 5)', () => {
    // A turn: otel-hook's input count includes cache reads and cache writes.
    const turn = {
      'otelhook.session.id': SID,
      'gen_ai.conversation.id': SID,
      'session.id': 'har-slot-session',
      'otelhook.generation.id': 'gen-turn-1',
      'otelhook.usage.temporality': 'delta',
      'gen_ai.request.model': 'claude-opus-4-1',
      'gen_ai.response.model': 'claude-opus-4-1',
      'gen_ai.usage.input_tokens': 5212,
      'gen_ai.usage.cache_read.input_tokens': 5000,
      'gen_ai.usage.cache_creation.input_tokens': 200,
      'gen_ai.usage.output_tokens': 340,
    };
    expect(otelHookGenerationObservation(span('generation claude-opus-4-1', turn), 'claude_code')).toEqual({
      agentTool: 'claude_code',
      sessionId: SID,
      observationKey: 'gen-turn-1',
      observedAt: new Date('2026-11-12T10:00:30.000Z'),
      granularity: 'turn',
      source: 'otel',
      producer: 'otelhook.generation',
      model: 'claude-opus-4-1',
      tokensInput: 12,
      tokensOutput: 340,
      tokensCacheRead: 5000,
      tokensCacheCreation: 200,
      costUsd: null,
    });
    // A subagent run: its own generation, the subagent's model, booked on the subagent.
    const subagent = otelHookGenerationObservation(
      span('generation claude-haiku-4-5', {
        ...turn,
        'otelhook.generation.id': 'gen-sub-1',
        'otelhook.subagent.id': 'agent-7',
        'gen_ai.response.model': 'claude-haiku-4-5',
      }),
      'claude_code',
    );
    expect(subagent).toMatchObject({ sessionId: SID, subagentId: 'agent-7', observationKey: 'gen-sub-1', model: 'claude-haiku-4-5' });
    expect(subagent).not.toHaveProperty('runningTotal');
  });

  it('ignores rollup spans and spans without usage', () => {
    expect(otelHookGenerationObservation(span('session', usage), 'cursor')).toBeNull();
    expect(otelHookGenerationObservation(span('subagent', usage), 'cursor')).toBeNull();
    expect(otelHookGenerationObservation(span('generation', { 'otelhook.session.id': 'c' }), 'cursor')).toBeNull();
  });
});
