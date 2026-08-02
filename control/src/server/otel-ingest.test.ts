import { describe, expect, it } from 'vitest';
import { extractPromptText, type AttrMap } from './otel-ingest';

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
