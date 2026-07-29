import { describe, expect, it } from 'vitest';
import { formatAgentToolLabel } from './agent-tool';

describe('formatAgentToolLabel', () => {
  it('labels known agent tools', () => {
    expect(formatAgentToolLabel('claude_code')).toBe('Claude');
    expect(formatAgentToolLabel('codex')).toBe('Codex');
    expect(formatAgentToolLabel('cursor')).toBe('Cursor');
    expect(formatAgentToolLabel('other')).toBe('other');
  });
});
