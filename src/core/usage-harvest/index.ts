import type { AgentSessionUsage } from '../../harness/schema';
import { harvestClaudeUsage, type HarvestSlotContext } from './claude';
import { harvestCodexUsage } from './codex';

export function harvestUsageForSlot(slot: HarvestSlotContext): AgentSessionUsage[] {
  const out: AgentSessionUsage[] = [];
  const claude = harvestClaudeUsage(slot);
  if (claude) out.push(claude);
  const codex = harvestCodexUsage(slot);
  if (codex) out.push(codex);
  return out;
}

export { harvestClaudeUsage, harvestCodexUsage };
export type { HarvestSlotContext };
