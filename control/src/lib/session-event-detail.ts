/**
 * Helpers for rendering Mission Control session event details.
 * Cursor / Claude / Codex hooks store most signal in OTEL attributes rather than
 * dedicated prompt/response columns.
 */

import { isSecretAttributeKey } from '@/lib/trajectory-privacy';

type AttrMap = Record<string, unknown>;

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function asAttrMap(attributes: unknown): AttrMap | null {
  if (!attributes || typeof attributes !== 'object' || Array.isArray(attributes)) return null;
  return attributes as AttrMap;
}

function attrString(attrs: AttrMap, ...keys: string[]): string | null {
  for (const key of keys) {
    if (isSecretAttributeKey(key)) continue;
    const value = asString(attrs[key]);
    if (value) return value;
  }
  return null;
}

/** Short hook / span name for table display. */
export function shortEventName(eventName: string): string {
  return eventName
    .replace(/^span\.gen_ai\.client\.hook\./, '')
    .replace(/^span\.gen_ai\.client\./, '')
    .replace(/^span\./, '');
}

/** True when a log row is only a duplicate “Hook event: …” mirror of a span. */
export function isRedundantLogEvent(eventName: string, rawTruncated?: string | null): boolean {
  if (eventName !== 'log') return false;
  return /Hook event:\s*\w+/i.test(rawTruncated ?? '');
}

/**
 * Redundant tool/generation bookends (`tool.start` / `tool.end`, `generation.start`, …).
 * Session start/end stay visible — they frame the run.
 */
export function isStartEndBoundaryEvent(eventName: string): boolean {
  const name = shortEventName(eventName).toLowerCase().replaceAll('_', '.');
  if (name.includes('session')) return false;
  return /(^|\.)(start|end)$/.test(name);
}

/** Views for the session events table (replaces a blunt “hide log mirrors” toggle). */
export type SessionEventView =
  | 'activity'
  | 'tools'
  | 'files'
  | 'prompts'
  | 'errors'
  | 'logs'
  | 'all';

export const SESSION_EVENT_VIEWS: Array<{ id: SessionEventView; label: string }> = [
  { id: 'activity', label: 'Activity' },
  { id: 'tools', label: 'Tools' },
  { id: 'files', label: 'Files' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'errors', label: 'Errors' },
  { id: 'logs', label: 'Logs' },
  { id: 'all', label: 'All' },
];

const ACTIVITY_TYPES = new Set([
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'BeforeShellExecution',
  'AfterShellExecution',
  'BeforeReadFile',
  'AfterFileEdit',
  'BeforeMCPExecution',
  'AfterMCPExecution',
  'Stop',
  'generation',
  'SessionStart',
  'SessionEnd',
  'prompt.submitted',
  'generation.start',
  'generation.end',
  'tool.start',
  'tool.end',
  'session.start',
  'session.end',
]);

/** Friendlier type label for log bodies like “Tool call: Read”. */
export function logEventKind(rawTruncated?: string | null): string | null {
  if (!rawTruncated) return null;
  const hook = rawTruncated.match(/Hook event:\s*(\w+)/i);
  if (hook) return hook[1];
  const toolCall = rawTruncated.match(/Tool call:\s*(\w+)/i);
  if (toolCall) return `ToolCall:${toolCall[1]}`;
  const toolResult = rawTruncated.match(/Tool result:\s*(\w+)/i);
  if (toolResult) return `ToolResult:${toolResult[1]}`;
  const conversation = rawTruncated.match(/Conversation event:\s*(\w+)/i);
  if (conversation) return `Conversation:${conversation[1]}`;
  return null;
}

export function displayEventType(eventName: string, rawTruncated?: string | null): string {
  if (eventName === 'log') {
    return logEventKind(rawTruncated) ?? 'log';
  }
  return shortEventName(eventName);
}

export function matchesSessionEventView(
  event: {
    eventName: string;
    promptText?: string | null;
    responseText?: string | null;
    attributes?: unknown;
    rawTruncated?: string | null;
  },
  view: SessionEventView,
): boolean {
  const name = shortEventName(event.eventName);
  const isLog = event.eventName === 'log';
  const isError = /Failure|Error/i.test(name) || /Failure|Error/i.test(event.rawTruncated ?? '');
  const attrs = asAttrMap(event.attributes);
  const promptFromAttrs = Boolean(
    attrs &&
      (textFromGenAiMessages(attrString(attrs, 'gen_ai.input.messages') ?? '') ||
        attrString(attrs, 'gen_ai.client.prompt.text', 'gen_ai.prompt', 'prompt')),
  );
  const isPrompt =
    name === 'UserPromptSubmit' ||
    name === 'prompt.submitted' ||
    Boolean(displayPromptText(event.promptText)) ||
    promptFromAttrs;
  const isTool =
    /ToolUse|ShellExecution|MCPExecution/i.test(name) ||
    name === 'tool.start' ||
    name === 'tool.end' ||
    Boolean(eventToolName(event.attributes)) ||
    /^Tool(Call|Result):/i.test(logEventKind(event.rawTruncated) ?? '');
  const isFile = /ReadFile|FileEdit/i.test(name);

  switch (view) {
    case 'all':
      return true;
    case 'logs':
      return isLog;
    case 'errors':
      return isError;
    case 'prompts':
      return isPrompt;
    case 'tools':
      return isTool && !isLog;
    case 'files':
      return isFile && !isLog;
    case 'activity':
    default:
      // Meaningful spans only — drop raw logs (including hook mirrors and tool-call log noise).
      return !isLog && (ACTIVITY_TYPES.has(name) || isPrompt || isError || isTool || isFile);
  }
}

/** Count events per view for filter badges. */
export function countSessionEventViews(
  events: Array<{
    eventName: string;
    promptText?: string | null;
    responseText?: string | null;
    attributes?: unknown;
    rawTruncated?: string | null;
  }>,
): Record<SessionEventView, number> {
  const counts = {
    activity: 0,
    tools: 0,
    files: 0,
    prompts: 0,
    errors: 0,
    logs: 0,
    all: events.length,
  } satisfies Record<SessionEventView, number>;
  for (const event of events) {
    for (const view of SESSION_EVENT_VIEWS) {
      if (view.id === 'all') continue;
      if (matchesSessionEventView(event, view.id)) counts[view.id] += 1;
    }
  }
  return counts;
}

/** Pull plain user/assistant text out of GenAI messages JSON when present. */
export function textFromGenAiMessages(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    const parts: string[] = [];
    for (const msg of messages) {
      if (!msg || typeof msg !== 'object') continue;
      const record = msg as { content?: unknown; parts?: unknown[]; text?: unknown };
      if (typeof record.content === 'string' && record.content.trim()) {
        parts.push(record.content.trim());
        continue;
      }
      if (typeof record.text === 'string' && record.text.trim()) {
        parts.push(record.text.trim());
        continue;
      }
      if (Array.isArray(record.parts)) {
        for (const part of record.parts) {
          if (!part || typeof part !== 'object') continue;
          const content =
            (part as { content?: unknown; text?: unknown }).content ??
            (part as { text?: unknown }).text;
          if (typeof content === 'string' && content.trim()) parts.push(content.trim());
        }
      }
    }
    return parts.length > 0 ? parts.join('\n') : null;
  } catch {
    return trimmed;
  }
}

/** Prefer plain prompt text; unwrap gen_ai.input.messages JSON blobs. */
export function displayPromptText(promptText: string | null | undefined): string | null {
  if (!promptText) return null;
  return textFromGenAiMessages(promptText) ?? (promptText.trim() || null);
}

export function eventToolName(attributes: unknown): string | null {
  const attrs = asAttrMap(attributes);
  if (!attrs) return null;
  return attrString(
    attrs,
    'gen_ai.tool.name',
    'gen_ai.client.tool_name',
    'gen_ai.client.mcp_tool',
  );
}

export function eventModel(attributes: unknown): string | null {
  const attrs = asAttrMap(attributes);
  if (!attrs) return null;
  return attrString(attrs, 'gen_ai.request.model', 'gen_ai.response.model');
}

/**
 * One-line detail for table cells: command, file, prompt, error, or tool name.
 */
export function eventDetailSummary(
  attributes: unknown,
  promptText?: string | null,
  responseText?: string | null,
  rawTruncated?: string | null,
): string | null {
  const prompt = displayPromptText(promptText);
  if (prompt) return prompt;

  const response = displayPromptText(responseText);
  if (response) return response;

  const attrs = asAttrMap(attributes);
  if (attrs) {
    const error = attrString(attrs, 'gen_ai.client.error.text');
    if (error) return error;

    const command = attrString(attrs, 'gen_ai.client.command');
    if (command) return command;

    const filePath = attrString(attrs, 'gen_ai.client.file_path');
    if (filePath) return filePath;

    const inputMessages = attrString(attrs, 'gen_ai.input.messages');
    const fromMessages = textFromGenAiMessages(inputMessages);
    if (fromMessages) return fromMessages;

    const tool = attrString(
      attrs,
      'gen_ai.tool.name',
      'gen_ai.client.tool_name',
      'gen_ai.client.mcp_tool',
    );
    if (tool) return tool;
  }

  if (rawTruncated?.trim()) {
    const kind = logEventKind(rawTruncated);
    if (kind && !kind.match(/^(Before|After|Pre|Post|User|Stop|Session)/)) {
      // ToolCall:Read / ToolResult:Grep — keep the raw line as detail.
      return rawTruncated.replace(/^\[[^\]]+\]\s*/, '').trim();
    }
    if (!/^\[.+\]\s*Hook event:/i.test(rawTruncated.trim())) {
      return rawTruncated.trim();
    }
  }
  return null;
}

/**
 * Human-readable detail lines for a session event from stored OTEL attributes.
 */
export function summarizeEventAttributes(attributes: unknown): string[] {
  const attrs = asAttrMap(attributes);
  if (!attrs) return [];
  const lines: string[] = [];

  const tool = attrString(
    attrs,
    'gen_ai.tool.name',
    'gen_ai.client.tool_name',
    'gen_ai.client.mcp_tool',
  );
  if (tool) lines.push(`tool: ${tool}`);

  const command = attrString(attrs, 'gen_ai.client.command');
  if (command) lines.push(`cmd: ${command}`);

  const filePath = attrString(attrs, 'gen_ai.client.file_path');
  if (filePath) lines.push(`file: ${filePath}`);

  const model = attrString(attrs, 'gen_ai.request.model', 'gen_ai.response.model');
  if (model) lines.push(`model: ${model}`);

  const exitCode = attrs['gen_ai.client.exit_code'];
  if (exitCode !== undefined && exitCode !== null && String(exitCode) !== '') {
    lines.push(`exit: ${String(exitCode)}`);
  }

  const status = attrString(attrs, 'gen_ai.client.status');
  if (status) lines.push(`status: ${status}`);

  const error = attrString(attrs, 'gen_ai.client.error.text');
  if (error) lines.push(`error: ${error}`);

  const inputMessages = attrString(attrs, 'gen_ai.input.messages');
  const promptFromMessages = textFromGenAiMessages(inputMessages);
  if (promptFromMessages) lines.push(`prompt: ${promptFromMessages}`);

  const outputMessages = attrString(attrs, 'gen_ai.output.messages');
  const responseFromMessages = textFromGenAiMessages(outputMessages);
  if (responseFromMessages) lines.push(`response: ${responseFromMessages}`);

  const promptText = attrString(
    attrs,
    'gen_ai.client.prompt.text',
    'gen_ai.prompt.0.content',
    'gen_ai.prompt',
    'user.prompt',
    'prompt',
  );
  if (promptText && !promptFromMessages) lines.push(`prompt: ${promptText}`);

  const responseText = attrString(
    attrs,
    'gen_ai.client.response.text',
    'gen_ai.completion',
    'assistant.response',
    'response',
  );
  if (responseText && !responseFromMessages) lines.push(`response: ${responseText}`);

  const toolCounts = attrString(attrs, 'gen_ai.client.memory.tool_counts');
  if (toolCounts) lines.push(`tools: ${toolCounts}`);

  return lines;
}
