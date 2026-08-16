import { describe, expect, it } from 'vitest';
import {
  displayEventType,
  displayPromptText,
  eventDetailSummary,
  eventToolName,
  isRedundantLogEvent,
  matchesSessionEventView,
  shortEventName,
  summarizeEventAttributes,
  textFromGenAiMessages,
} from './session-event-detail';

describe('shortEventName', () => {
  it('strips span prefixes', () => {
    expect(shortEventName('span.gen_ai.client.hook.PreToolUse')).toBe('PreToolUse');
    expect(shortEventName('span.gen_ai.client.generation')).toBe('generation');
    expect(shortEventName('log')).toBe('log');
  });
});

describe('isRedundantLogEvent', () => {
  it('flags hook-event log mirrors', () => {
    expect(isRedundantLogEvent('log', '[abc] Hook event: BeforeReadFile')).toBe(true);
    expect(isRedundantLogEvent('log', '[abc] Tool call: Read')).toBe(false);
    expect(isRedundantLogEvent('span.x', '[abc] Hook event: BeforeReadFile')).toBe(false);
  });
});

describe('textFromGenAiMessages', () => {
  it('extracts user text from GenAI messages JSON', () => {
    const raw = JSON.stringify([
      { role: 'user', parts: [{ type: 'text', content: 'turn down the agent' }] },
    ]);
    expect(textFromGenAiMessages(raw)).toBe('turn down the agent');
  });
});

describe('displayPromptText', () => {
  it('unwraps stored gen_ai.input.messages blobs', () => {
    const raw = JSON.stringify([
      { role: 'user', parts: [{ type: 'text', content: 'Fix the flaky tests' }] },
    ]);
    expect(displayPromptText(raw)).toBe('Fix the flaky tests');
  });
});

describe('eventDetailSummary', () => {
  it('does not surface secret-bearing attributes as visible content', () => {
    expect(eventDetailSummary({
      authorization: 'Bearer leaked',
      'gen_ai.request.api_key': 'sk-secret',
      'gen_ai.client.tool_name': 'Read',
    })).toBe('Read');
    expect(summarizeEventAttributes({
      authorization: 'Bearer leaked',
      'gen_ai.client.tool_name': 'Read',
    })).toEqual(['tool: Read']);
  });

  it('prefers command / file / error from attributes', () => {
    expect(
      eventDetailSummary({
        'gen_ai.client.command': 'ls -la',
        'gen_ai.client.tool_name': 'Shell',
      }),
    ).toBe('ls -la');
    expect(
      eventDetailSummary({
        'gen_ai.client.file_path': '/tmp/foo.ts',
      }),
    ).toBe('/tmp/foo.ts');
    expect(
      eventDetailSummary({
        'gen_ai.client.error.text': 'File not found',
      }),
    ).toBe('File not found');
  });
});

describe('summarizeEventAttributes', () => {
  it('surfaces Cursor tool / shell / file details', () => {
    expect(
      summarizeEventAttributes({
        'gen_ai.client.tool_name': 'Shell',
        'gen_ai.client.command': 'ls -la',
        'gen_ai.request.model': 'grok-4.5',
      }),
    ).toEqual(['tool: Shell', 'cmd: ls -la', 'model: grok-4.5']);
  });
});

describe('event views', () => {
  it('labels log kinds and filters activity vs logs', () => {
    expect(displayEventType('log', '[abc] Tool call: Read')).toBe('ToolCall:Read');
    expect(displayEventType('span.gen_ai.client.hook.PreToolUse')).toBe('PreToolUse');

    const toolSpan = {
      eventName: 'span.gen_ai.client.hook.PreToolUse',
      attributes: { 'gen_ai.client.tool_name': 'Shell' },
    };
    const logMirror = {
      eventName: 'log',
      rawTruncated: '[abc] Hook event: PreToolUse',
    };
    expect(matchesSessionEventView(toolSpan, 'activity')).toBe(true);
    expect(matchesSessionEventView(logMirror, 'activity')).toBe(false);
    expect(matchesSessionEventView(logMirror, 'logs')).toBe(true);
    expect(matchesSessionEventView(toolSpan, 'tools')).toBe(true);
  });

  it('classifies canonical otelhook events and standard tool names', () => {
    const tool = {
      eventName: 'tool.start',
      attributes: { 'gen_ai.tool.name': 'shell' },
    };
    const prompt = { eventName: 'prompt.submitted' };
    const generation = { eventName: 'generation.end' };

    expect(eventToolName(tool.attributes)).toBe('shell');
    expect(matchesSessionEventView(tool, 'tools')).toBe(true);
    expect(matchesSessionEventView(prompt, 'prompts')).toBe(true);
    expect(matchesSessionEventView(generation, 'activity')).toBe(true);
  });
});
