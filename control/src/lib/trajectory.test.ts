import { describe, expect, it } from 'vitest';
import {
  assembleTrajectory,
  formatDurationMs,
  leadInNodeIds,
  mergeTrajectoryRecords,
  safeTrajectoryBody,
  trajectoryOverviewPlacement,
  trajectoryRoleLabel,
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
  it('builds a Claude Code trajectory from otel-hook logs: sequence order, tool pairs, subagent nesting', () => {
    // otel-hook canonical log records, delivered out of order (ADR 0005 section 3).
    const claude = (id: string, sequence: number, eventType: string, attributes: Record<string, unknown>, contentKind = 'event') =>
      record(id, {
        agentTool: 'claude_code',
        eventType,
        sequence,
        contentKind,
        contentDisclosure: 'metadata_only',
        eventTimestamp: new Date(Date.parse('2026-11-26T10:00:00.000Z') + sequence * 1000).toISOString(),
        payload: { attributes: { 'otelhook.event.type': eventType, 'otelhook.event.sequence': sequence, ...attributes } },
      });
    const records = [
      claude('tool-end', 4, 'tool.end', { 'gen_ai.tool.call_id': 'call-1', 'otelhook.outcome': 'ok' }),
      claude('start', 1, 'session.start', { 'otelhook.agent.name': 'claude-code' }),
      claude('prompt', 2, 'prompt.submitted', { 'otelhook.prompt.source': 'user' }, 'prompt'),
      claude('tool-start', 3, 'tool.start', { 'gen_ai.tool.name': 'Agent', 'gen_ai.tool.call_id': 'call-1' }),
      claude('sub-start', 5, 'subagent.start', { 'otelhook.subagent.id': 'agent-7', 'otelhook.subagent.type': 'Explore' }),
      claude('sub-tool-start', 6, 'tool.start', { 'gen_ai.tool.name': 'Read', 'gen_ai.tool.call_id': 'call-2', 'otelhook.subagent.id': 'agent-7' }),
      claude('sub-tool-end', 7, 'tool.end', { 'gen_ai.tool.call_id': 'call-2', 'otelhook.outcome': 'ok', 'otelhook.subagent.id': 'agent-7' }),
      claude('sub-end', 8, 'subagent.end', { 'otelhook.subagent.id': 'agent-7' }),
    ];

    const nodes = assembleTrajectory(records);

    expect(nodes.map((node) => [node.kind, node.title, node.status ?? null, node.subagentId ?? null])).toEqual([
      ['metadata', 'Session started', null, null],
      ['prompt', 'User prompt', null, null],
      ['tool', 'Agent', 'completed', null],
      ['subagent', 'Explore', 'completed', null],
      ['tool', 'Read', 'completed', 'agent-7'],
    ]);
  });

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
    expect(safeTrajectoryBody(record('wrapped', {
      contentKind: 'prompt',
      payload: { body: { stringValue: 'unwrap me' } },
    }))).toBe('unwrap me');
  });

  it('omits span-only mirror records from the assembled timeline', () => {
    const nodes = assembleTrajectory([
      record('prompt', {
        eventType: 'prompt.submitted',
        contentKind: 'prompt',
        payload: { promptText: 'read the file' },
      }),
      record('span', {
        sequence: 2,
        eventType: 'span.tool',
        contentKind: 'span',
        contentLabel: 'Read',
      }),
      record('start', {
        sequence: 3,
        eventType: 'tool.start',
        toolCallId: 'call-9',
        contentLabel: 'Read',
      }),
      record('end', {
        sequence: 4,
        eventType: 'tool.end',
        toolCallId: 'call-9',
      }),
    ]);
    expect(nodes.map((node) => node.kind)).toEqual(['prompt', 'tool']);
    expect(nodes.some((node) => node.records.some((item) => item.id === 'span'))).toBe(false);
  });

  it('keeps session start/end and message-bearing generation ends, but drops empty generation bookends', () => {
    const nodes = assembleTrajectory([
      record('session-start', { eventType: 'session.start', contentKind: 'metadata' }),
      record('prompt', { sequence: 2, eventType: 'prompt.submitted', contentKind: 'prompt' }),
      record('gen-start', { sequence: 3, eventType: 'generation.start', contentKind: 'metadata' }),
      record('gen-end', {
        sequence: 4,
        eventType: 'generation.end',
        contentKind: 'response',
        payload: { responseText: 'done' },
      }),
      record('session-end', { sequence: 5, eventType: 'session.end', contentKind: 'metadata' }),
    ]);
    expect(nodes.map((node) => node.title)).toEqual([
      'Session started',
      'User prompt',
      'Assistant response',
      'Session ended',
    ]);
  });

  it('places input, model, and tool nodes on overview lanes', () => {
    const nodes = assembleTrajectory([
      record('prompt', { eventType: 'prompt.submitted', contentKind: 'prompt', sequence: 1 }),
      record('response', { eventType: 'response', contentKind: 'response', sequence: 2 }),
      record('start', { eventType: 'tool.start', toolCallId: 'c', sequence: 3 }),
      record('end', { eventType: 'tool.end', toolCallId: 'c', sequence: 4 }),
    ]);
    expect(nodes.map((node) => trajectoryRoleLabel(node.kind))).toEqual(['USER', 'ASSISTANT', 'TOOL']);
    expect(trajectoryOverviewPlacement(nodes).map((item) => item.lane)).toEqual([
      'input',
      'model',
      'tools',
    ]);
    expect(formatDurationMs(21)).toBe('21 ms');
  });
});

describe('session lead-in', () => {
  it('marks the prompt typed in the main checkout before the slot launch', () => {
    const prompt = record('prompt', {
      agentId: 0,
      sequence: 1,
      eventType: 'prompt.submitted',
      contentKind: 'prompt',
      payload: { body: 'fix issue #7560' },
    });
    const work = record('work', { agentId: 3, sequence: 2, eventType: 'agent.response', contentKind: 'response' });
    const nodes = assembleTrajectory([work, prompt]);

    expect(nodes.map((node) => node.kind)).toEqual(['prompt', 'response']);
    expect([...leadInNodeIds(nodes)]).toEqual(['prompt']);
  });

  it('marks nothing in a stream that never entered a slot', () => {
    const nodes = assembleTrajectory([
      record('a', { agentId: 0, eventType: 'prompt.submitted', contentKind: 'prompt' }),
    ]);
    expect(leadInNodeIds(nodes).size).toBe(0);
  });
});

