import type { AgentSessionEvent, AgentSessionUsage } from '../../harness/schema';
import {
  harvestClaudeEvents,
  harvestClaudeUsage,
  type HarvestSlotContext,
} from './claude';
import { harvestCodexUsage } from './codex';

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
