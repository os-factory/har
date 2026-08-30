import { describe, expect, it } from 'vitest';
import type { AgentTrajectoryRecord } from '@prisma/client';
import {
  eventInputFromTrajectoryRecord,
  usageFromTrajectoryRecord,
} from './trajectory-projections';

function record(overrides: Partial<AgentTrajectoryRecord> = {}): AgentTrajectoryRecord {
  return {
    id: 'row-1',
    repositoryId: 'repo-1',
    occupancyKey: null,
    version: 1,
    source: 'otel',
    sourceEventId: 'evt-1',
    contentKey: 'prompt',
    sessionKey: 'session-1',
    agentId: 2,
    agentTool: 'cursor',
    eventType: 'prompt.submitted',
    sequence: 4,
    eventTimestamp: new Date('2026-08-14T10:00:00.000Z'),
    payload: {
      body: 'refactor auth',
      attributes: {
        authorization: 'Bearer leaked',
        'gen_ai.usage.input_tokens': 11,
        'gen_ai.request.model': 'grok-4.5',
      },
      session: { workDir: '/tmp/work', branch: 'feat/x', suffix: 'abcd' },
    },
    contentKind: 'prompt',
    contentDisclosure: 'full',
    contentLabel: null,
    traceId: null,
    spanId: null,
    parentSpanId: null,
    generationId: null,
    toolCallId: null,
    correlationId: null,
    workUnitId: null,
    attemptId: null,
    createdAt: new Date('2026-08-14T10:00:01.000Z'),
    ...overrides,
  };
}

describe('trajectory projections', () => {
  it('projects event columns from ledger content and redacts secrets', () => {
    const event = eventInputFromTrajectoryRecord(record());
    expect(event).toMatchObject({
      eventName: 'prompt.submitted',
      sequence: 4,
      promptText: 'refactor auth',
      source: 'otel',
    });
    expect(event.attributes).toMatchObject({
      authorization: '[redacted]',
      'gen_ai.usage.input_tokens': 11,
    });
  });

  it('never copies withheld bodies into event projections', () => {
    const event = eventInputFromTrajectoryRecord(record({
      contentDisclosure: 'withheld',
      payload: { body: 'secret reasoning', attributes: {} },
    }));
    expect(event.promptText).toBeNull();
    expect(event.responseText).toBeNull();
    expect(event.rawTruncated).toBeNull();
  });

  it('derives usage from ledger attributes when tokens are present', () => {
    expect(usageFromTrajectoryRecord(record())).toMatchObject({
      tokensInput: 11,
      tokensTotal: 11,
      workDir: '/tmp/work',
      sources: ['otel'],
      modelBreakdown: { 'grok-4.5': { tokensInput: 11 } },
    });
    expect(usageFromTrajectoryRecord(record({
      payload: { attributes: { 'gen_ai.request.model': 'grok-4.5' } },
    }))).toBeNull();
  });
});
