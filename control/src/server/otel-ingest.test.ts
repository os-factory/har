import { describe, expect, it } from 'vitest';
import {
  canonicalizeOtelLogRecord,
  canonicalizeOtelSpan,
  canonicalSpanSequence,
  detectAgentTool,
  extractLogRecords,
  extractPromptText,
  extractResponseText,
  type AttrMap,
} from './otel-ingest';

describe('extractPromptText', () => {
  it('reads gen_ai.prompt style attributes (existing behavior)', () => {
    const attrs: AttrMap = { 'gen_ai.prompt.0.content': 'fix the bug' };
    expect(extractPromptText(attrs)).toBe('fix the bug');
  });

  it('reads @osfactory/otel-hook prompt.submitted content facts from the log body', () => {
    const attrs: AttrMap = {
      'otelhook.event.type': 'prompt.submitted',
      'otelhook.content.kind': 'prompt',
    };
    expect(extractPromptText(attrs, 'otelhook.prompt.submitted', 'refactor the auth module')).toBe(
      'refactor the auth module',
    );
  });

  it('does not read the body when the content kind is not prompt', () => {
    const attrs: AttrMap = {
      'otelhook.event.type': 'prompt.submitted',
      'otelhook.content.kind': 'response',
    };
    expect(extractPromptText(attrs, 'otelhook.prompt.submitted', 'not a prompt')).toBeNull();
  });

  it('does not read the body for a different event type', () => {
    const attrs: AttrMap = {
      'otelhook.event.type': 'generation.end',
      'otelhook.content.kind': 'prompt',
    };
    expect(extractPromptText(attrs, 'otelhook.generation.end', 'irrelevant text')).toBeNull();
  });

  it('withholds the body when otelhook.content.withheld is set', () => {
    const attrs: AttrMap = {
      'otelhook.event.type': 'prompt.submitted',
      'otelhook.content.kind': 'prompt',
      'otelhook.content.withheld': 'privacy-policy',
    };
    expect(extractPromptText(attrs, 'otelhook.prompt.submitted', 'should not appear')).toBeNull();
  });

  it('returns null when there is no body text at all', () => {
    const attrs: AttrMap = {
      'otelhook.event.type': 'prompt.submitted',
      'otelhook.content.kind': 'prompt',
    };
    expect(extractPromptText(attrs, 'otelhook.prompt.submitted', null)).toBeNull();
  });

  it('is case-insensitive on event type and content kind', () => {
    const attrs: AttrMap = {
      'otelhook.event.type': 'Prompt.Submitted',
      'otelhook.content.kind': 'Prompt',
    };
    expect(extractPromptText(attrs, undefined, 'hello there')).toBe('hello there');
  });
});

describe('extractResponseText', () => {
  it('symmetrically reads generation response facts', () => {
    const attrs: AttrMap = {
      'otelhook.event.type': 'generation.end',
      'otelhook.content.kind': 'response',
    };
    expect(extractResponseText(attrs, undefined, 'completed answer')).toBe('completed answer');
  });

  it('withholds the body when otelhook.content.withheld is set', () => {
    const attrs: AttrMap = {
      'otelhook.event.type': 'generation.end',
      'otelhook.content.kind': 'response',
      'otelhook.content.withheld': 'privacy-policy',
    };
    expect(extractResponseText(attrs, 'otelhook.generation.end', 'secret answer')).toBeNull();
  });

  it('does not misclassify reasoning as a response', () => {
    const attrs: AttrMap = {
      'otelhook.event.type': 'generation.end',
      'otelhook.content.kind': 'reasoning',
    };
    expect(extractResponseText(attrs, undefined, 'private chain')).toBeNull();
  });
});

describe('canonical OTLP log facts', () => {
  it('prefers record event names and canonical event ids, types, and sequences', () => {
    const [record] = extractLogRecords({
      resourceLogs: [{
        resource: { attributes: [] },
        scopeLogs: [{
          logRecords: [{
            eventName: 'sdk.log.name',
            traceId: 'trace-1',
            spanId: 'span-1',
            timeUnixNano: '1786701600000000000',
            attributes: [
              { key: 'otelhook.event.id', value: { stringValue: 'evt-9' } },
              { key: 'otelhook.event.type', value: { stringValue: 'tool.end' } },
              { key: 'otelhook.event.sequence', value: { intValue: '42' } },
              { key: 'otelhook.content.kind', value: { stringValue: 'tool_output' } },
              { key: 'otelhook.content.disclosure', value: { stringValue: 'redact' } },
              { key: 'otelhook.content.body_truncated', value: { boolValue: true } },
              { key: 'otelhook.generation.id', value: { stringValue: 'generation-1' } },
              { key: 'gen_ai.tool.call.id', value: { stringValue: 'tool-call-1' } },
            ],
            body: { stringValue: '{"ok":true}' },
          }],
        }],
      }],
    });

    expect(record.eventName).toBe('sdk.log.name');
    expect(canonicalizeOtelLogRecord(record)).toMatchObject({
      eventType: 'tool.end',
      sequence: 42,
      sourceEventId: 'evt-9',
      contentKind: 'tool_output',
      contentDisclosure: 'truncated',
      generationId: 'generation-1',
      toolCallId: 'tool-call-1',
      correlationId: 'tool-call-1',
      payload: { body: { stringValue: '{"ok":true}' } },
    });
    expect(record).toMatchObject({ traceId: 'trace-1', spanId: 'span-1' });
  });

  it('keeps reasoning disclosure metadata without exposing a withheld body', () => {
    const canonical = canonicalizeOtelLogRecord({
      resource: {},
      eventName: 'log',
      attributes: {
        'otelhook.event.type': 'generation.end',
        'otelhook.event.id': 'evt-10',
        'otelhook.content.kind': 'reasoning',
        'otelhook.content.withheld': 'policy',
      },
      timestamp: new Date('2026-08-14T10:00:00.000Z'),
      body: null,
      bodyText: null,
      sequence: 3,
    });
    expect(canonical).toMatchObject({
      contentKind: 'reasoning',
      contentDisclosure: 'withheld',
      payload: {
        body: null,
        disclosure: { withheld: 'policy' },
      },
    });
  });

  it('canonicalizes a prompt → generation → tool → response sequence without inventing order', () => {
    const [prompt, tool, response] = extractLogRecords({
      resourceLogs: [{
        resource: { attributes: [] },
        scopeLogs: [{
          logRecords: [
            {
              eventName: 'otelhook.prompt.submitted',
              attributes: [
                { key: 'otelhook.event.id', value: { stringValue: 'evt-prompt' } },
                { key: 'otelhook.event.type', value: { stringValue: 'prompt.submitted' } },
                { key: 'otelhook.event.sequence', value: { intValue: '1' } },
                { key: 'otelhook.content.kind', value: { stringValue: 'prompt' } },
              ],
              body: { stringValue: 'fix the flaky test' },
            },
            {
              eventName: 'otelhook.tool.start',
              attributes: [
                { key: 'otelhook.event.id', value: { stringValue: 'evt-tool' } },
                { key: 'otelhook.event.type', value: { stringValue: 'tool.start' } },
                { key: 'otelhook.event.sequence', value: { intValue: '2' } },
                { key: 'otelhook.content.kind', value: { stringValue: 'tool_input' } },
                { key: 'gen_ai.tool.name', value: { stringValue: 'Read' } },
              ],
              body: { stringValue: 'tests/flaky.test.ts' },
            },
            {
              eventName: 'otelhook.generation.end',
              attributes: [
                { key: 'otelhook.event.id', value: { stringValue: 'evt-response' } },
                { key: 'otelhook.event.type', value: { stringValue: 'generation.end' } },
                { key: 'otelhook.event.sequence', value: { intValue: '3' } },
                { key: 'otelhook.content.kind', value: { stringValue: 'response' } },
              ],
              body: { stringValue: 'updated the assertion' },
            },
          ],
        }],
      }],
    }).map((record) => canonicalizeOtelLogRecord(record));

    expect(prompt).toMatchObject({ eventType: 'prompt.submitted', sequence: 1, contentKind: 'prompt' });
    expect(tool).toMatchObject({ eventType: 'tool.start', sequence: 2, contentKind: 'tool_input' });
    expect(response).toMatchObject({ eventType: 'generation.end', sequence: 3, contentKind: 'response' });
    expect(prompt.sequence).toBeLessThan(tool.sequence);
    expect(tool.sequence).toBeLessThan(response.sequence);
  });

  it('does not persist withheld bodies or secret attributes on the canonical payload', () => {
    const canonical = canonicalizeOtelLogRecord({
      resource: {},
      eventName: 'log',
      attributes: {
        'otelhook.event.type': 'generation.end',
        'otelhook.event.id': 'evt-secret',
        'otelhook.content.kind': 'response',
        'otelhook.content.withheld': 'privacy-policy',
        authorization: 'Bearer leaked-token',
        'gen_ai.tool.name': 'Read',
      },
      timestamp: new Date('2026-08-14T10:00:00.000Z'),
      body: { stringValue: 'should not be stored' },
      bodyText: 'should not be stored',
      sequence: 9,
    });
    expect(canonical.contentDisclosure).toBe('withheld');
    expect(canonical.payload.body).toBeNull();
    expect(canonical.payload.attributes).toMatchObject({
      authorization: '[redacted]',
      'gen_ai.tool.name': 'Read',
    });
  });

  it('preserves redacted disclosure when a safe body is exported', () => {
    const canonical = canonicalizeOtelLogRecord({
      resource: {},
      eventName: 'otelhook.generation.end',
      attributes: {
        'otelhook.event.type': 'generation.end',
        'otelhook.event.id': 'evt-11',
        'otelhook.content.kind': 'response',
        'otelhook.content.disclosure': 'redact',
      },
      timestamp: new Date('2026-08-14T10:00:00.000Z'),
      body: { stringValue: 'safe redacted answer' },
      bodyText: 'safe redacted answer',
      sequence: 4,
    });
    expect(canonical.contentDisclosure).toBe('redacted');
  });
});

describe('canonical OTLP span facts', () => {
  it('uses producer sequence when present and never a span-id hash', () => {
    expect(canonicalSpanSequence({
      'otelhook.event.sequence': 6,
      sequence: 99,
    })).toBe(6);
    expect(canonicalSpanSequence({})).toBe(0);
    expect(canonicalSpanSequence({ sequence: 'not-a-number' })).toBe(0);

    const canonical = canonicalizeOtelSpan({
      resource: {},
      traceId: 'trace-1',
      spanId: 'deadbeefcafebabe',
      parentSpanId: null,
      name: 'gen_ai.client.generation',
      startTime: new Date('2026-08-14T10:00:00.000Z'),
      endTime: new Date('2026-08-14T10:00:01.000Z'),
      attributes: {
        'otelhook.event.sequence': 12,
        authorization: 'Bearer leaked',
        'gen_ai.client.prompt.text': 'hello',
      },
    });
    expect(canonical.sequence).toBe(12);
    expect(canonical.sourceEventId).toBe('span:trace-1:deadbeefcafebabe');
    expect(canonical.sequence).not.toBe(
      Math.abs(Number.parseInt('deadbeefcafebabe'.replace(/\D/g, '').slice(-8) || '0', 16)),
    );
    expect(canonical.payload.attributes).toMatchObject({ authorization: '[redacted]' });
  });
});

describe('detectAgentTool', () => {
  it('reads otelhook provider and agent name before defaulting', () => {
    expect(detectAgentTool({ 'otelhook.provider.id': 'claude-code' })).toBe('claude_code');
    expect(detectAgentTool({ 'otelhook.agent.name': 'claude-code' })).toBe('claude_code');
    expect(detectAgentTool({ 'gen_ai.client.name': 'cursor' })).toBe('cursor');
  });
});
