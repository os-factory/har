import { describe, expect, it } from 'vitest';
import {
  canonicalizeOtelLogRecord,
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
