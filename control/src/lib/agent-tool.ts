/** Display label for stored `agentTool` values (claude_code / codex / cursor / …). */
export function formatAgentToolLabel(tool: string): string {
  if (tool === 'claude_code') return 'Claude';
  if (tool === 'codex') return 'Codex';
  if (tool === 'cursor') return 'Cursor';
  return tool;
}
