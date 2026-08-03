import * as fs from 'fs';
import * as path from 'path';
import { getHarnessDir } from '../harness/manifest';
import { SlotRegistryEntry, SlotRegistryEntrySchema } from '../harness/schema';

export function getSlotRegistryDir(repoPath: string): string {
  return path.join(getHarnessDir(repoPath), 'slots');
}

export function getSlotRegistryPath(repoPath: string, agentId: number): string {
  return path.join(getSlotRegistryDir(repoPath), `agent-${agentId}.json`);
}

/** Whether a partial launch can be resumed via --resume instead of tearing down first. */
export function isSlotResumable(session: SlotRegistryEntry | undefined): boolean {
  return session?.status === 'failed' || session?.status === 'starting';
}

/** Read one slot's session entry; undefined when missing or invalid. */
export function readSlotRegistry(
  repoPath: string,
  agentId: number,
): SlotRegistryEntry | undefined {
  const file = getSlotRegistryPath(repoPath, agentId);
  if (!fs.existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = SlotRegistryEntrySchema.safeParse(raw);
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

export function listSlotRegistryEntries(repoPath: string): SlotRegistryEntry[] {
  const dir = getSlotRegistryDir(repoPath);
  if (!fs.existsSync(dir)) return [];
  const entries: SlotRegistryEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^agent-(\d+)\.json$/);
    if (!match) continue;
    const entry = readSlotRegistry(repoPath, Number(match[1]));
    if (entry) entries.push(entry);
  }
  return entries;
}
