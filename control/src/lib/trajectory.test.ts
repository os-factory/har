import { describe, expect, it } from 'vitest';
import {
  assembleTrajectory,
  mergeTrajectoryRecords,
  safeTrajectoryBody,
  type SerializedTrajectoryRecord,
} from './trajectory';

function record(
  id: string,
  overrides: Partial<SerializedTrajectoryRecord> = {},
): SerializedTrajectoryRecord {
  return {
    id,
    repositoryId: 'repo-1',
    version: 1,
    source: 'otel',
    sourceEventId: id,
    contentKey: `content-${id}`,
    sessionKey: 'session-1',
    agentId: 3,
    agentTool: 'cursor',
    eventType: 'event',
    sequence: 1,
    eventTimestamp: '2026-08-14T10:00:00.000Z',
    payload: {},
    contentKind: 'event',
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
    createdAt: '2026-08-14T10:00:00.000Z',
    ...overrides,
  };
}

describe('trajectory assembler', () => {
  it('deduplicates row ids and applies canonical ordering', () => {
    const later = record('later', { sequence: 2 });
    const first = record('first', { contentKey: 'a' });
    const second = record('second', { contentKey: 'b' });

    expect(mergeTrajectoryRecords([later, second], [first, later]).map((item) => item.id)).toEqual([
      'first',
      'second',
      'later',
    ]);
  });

  it('pairs tool boundaries by explicit otelhook call id and keeps unmatched starts running', () => {
    const start = record('start', {
      eventType: 'tool.start',
      contentKind: 'tool_input',
      contentLabel: 'Read file',
      payload: { attributes: { 'otelhook.tool.call.id': 'call-7' }, body: '/tmp/file' },
    });
    const end = record('end', {
      sequence: 2,
      eventType: 'tool.end',
      contentKind: 'tool_output',
      payload: { attributes: { 'otelhook.tool.call.id': 'call-7' }, body: 'contents' },
    });
    const running = record('running', {
      sequence: 3,
      eventType: 'tool.start',
      contentKind: 'tool_input',
      correlationId: 'fallback-8',
    });

    const nodes = assembleTrajectory([end, running, start]);
    expect(nodes[0]).toMatchObject({
      kind: 'tool',
      title: 'Read file',
      status: 'completed',
      records: [{ id: 'start' }, { id: 'end' }],
    });
    expect(nodes[1]).toMatchObject({
      kind: 'tool',
      status: 'running',
      note: expect.stringContaining('no explicit call id'),
    });
  });

  it('uses canonical tool call ids and preserves failed outcomes', () => {
    const start = record('start', {
      eventType: 'tool.start',
      toolCallId: 'call-8',
    });
    const end = record('end', {
      sequence: 2,
      eventType: 'tool.end',
      toolCallId: 'call-8',
      payload: { attributes: { 'otelhook.outcome': 'error' } },
    });
    expect(assembleTrajectory([end, start])[0]).toMatchObject({
      kind: 'tool',
      status: 'error',
      records: [{ id: 'start' }, { id: 'end' }],
    });
  });

  it('does not claim a correlation when an end has no matching start', () => {
    const [node] = assembleTrajectory([
      record('end', { eventType: 'subagent.end', contentKind: 'metadata' }),
    ]);
    expect(node).toMatchObject({
      kind: 'subagent',
      status: 'unmatched',
      note: expect.stringContaining('No matching start'),
    });
  });

  it('classifies messages and preserves disclosure without exposing protected bodies', () => {
    const withheld = record('reasoning', {
      eventType: 'generation.end',
      contentKind: 'reasoning',
      contentDisclosure: 'withheld',
      payload: { body: 'secret reasoning', disclosure: { withheld: 'policy' } },
    });
    const metadataOnly = record('prompt', {
      contentKind: 'prompt',
      contentDisclosure: 'metadata_only',
      payload: { body: 'secret prompt' },
    });
    const truncated = record('response', {
      contentKind: 'response',
      contentDisclosure: 'truncated',
      payload: { responseText: 'partial answer', body: 'fallback' },
    });

    expect(assembleTrajectory([withheld, metadataOnly, truncated]).map((node) => node.kind)).toEqual([
      'prompt',
      'reasoning',
      'response',
    ]);
    expect(safeTrajectoryBody(withheld)).toBeNull();
    expect(safeTrajectoryBody(metadataOnly)).toBeNull();
    expect(safeTrajectoryBody(truncated)).toBe('partial answer');
  });
});
