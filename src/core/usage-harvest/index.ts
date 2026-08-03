import type { AgentSessionEvent, AgentSessionUsage } from '../../harness/schema';
import {
  harvestClaudeEvents,
  harvestClaudeUsage,
  type HarvestSlotContext,
} from './claude';
import { harvestCodexUsage } from './codex';

function sessionToolKey(sessionKey: string, agentTool: string): string {
  return `${sessionKey}\0${agentTool}`;
}

/** Skip harvest rows when Mission Control already has OTLP usage for that session/tool. */
export function omitHarvestWhenOtelPresent(
  harvested: AgentSessionUsage[],
  existing: AgentSessionUsage[],
): AgentSessionUsage[] {
  const otelKeys = new Set(
    existing
      .filter((row) => (row.sources ?? []).includes('otel'))
      .map((row) => sessionToolKey(row.sessionKey, row.agentTool)),
  );
  if (otelKeys.size === 0) return harvested;
  return harvested.filter((row) => !otelKeys.has(sessionToolKey(row.sessionKey, row.agentTool)));
}

/** Skip harvested prompt events when OTLP events already exist for that session/tool. */
export function omitHarvestEventsWhenOtelPresent(
  harvested: AgentSessionEvent[],
  existing: AgentSessionEvent[],
): AgentSessionEvent[] {
  const otelKeys = new Set(
    existing
      .filter((event) => event.source === 'otel')
      .map((event) => sessionToolKey(event.sessionKey, event.agentTool)),
  );
  if (otelKeys.size === 0) return harvested;
  return harvested.filter(
    (event) => !otelKeys.has(sessionToolKey(event.sessionKey, event.agentTool)),
  );
}

export function harvestUsageForSlot(slot: HarvestSlotContext): AgentSessionUsage[] {
  const out: AgentSessionUsage[] = [];
  const claude = harvestClaudeUsage(slot);
  if (claude) out.push(claude);
  const codex = harvestCodexUsage(slot);
  if (codex) out.push(codex);
  return out;
}

export function harvestEventsForSlot(slot: HarvestSlotContext): AgentSessionEvent[] {
  return harvestClaudeEvents(slot);
}

export { harvestClaudeUsage, harvestClaudeEvents, harvestCodexUsage };
export type { HarvestSlotContext };
