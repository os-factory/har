import * as fs from 'fs';
import * as path from 'path';
import { getHarnessDir } from '../harness/manifest';
import { SlotRegistryEntry, SlotRegistryEntrySchema } from '../harness/schema';
import { notifyControlSync } from './control-notify';

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

export interface SlotRegistryWriteInput {
  agentId: number;
  projectName: string;
  mode: 'worktree' | 'root';
  workDir: string;
  status?: 'starting' | 'active' | 'failed' | 'completed';
  suffix?: string;
  worktreePath?: string;
  branch?: string;
  baseBranch?: string;
  baseCommit?: string;
  lastError?: string;
  workUnitId?: string;
  attemptId?: string;
  ports?: Record<string, number>;
  previewUrls?: Record<string, string>;
  /** Injectable for byte-compat tests; defaults to now. */
  createdAt?: string;
  /** Skip the detached Mission Control nudge (tests, batch writes). */
  notifyControl?: boolean;
}

/**
 * Write one slot's session entry — the single registry writer (#234).
 * Field order and formatting (2-space indent, trailing newline) are
 * byte-compatible with the retired bash write_slot_registry, so existing
 * tooling diffing registry files sees no change.
 */
export function writeSlotRegistry(repoPath: string, input: SlotRegistryWriteInput): string {
  const entry: Record<string, unknown> = {
    version: 1,
    agentId: input.agentId,
    projectName: input.projectName ?? '',
    mode: input.mode,
    workDir: input.workDir,
    createdAt: input.createdAt ?? new Date().toISOString(),
    status: input.status ?? 'active',
  };
  if (input.suffix) entry.suffix = input.suffix;
  if (input.worktreePath) entry.worktreePath = input.worktreePath;
  if (input.branch) entry.branch = input.branch;
  if (input.baseBranch) entry.baseBranch = input.baseBranch;
  if (input.baseCommit) entry.baseCommit = input.baseCommit;
  if (input.lastError) entry.lastError = input.lastError;
  if (input.workUnitId) entry.workUnitId = input.workUnitId;
  if (input.attemptId) entry.attemptId = input.attemptId;
  if (input.ports) entry.ports = input.ports;
  if (input.previewUrls) entry.previewUrls = input.previewUrls;

  const result = SlotRegistryEntrySchema.safeParse(entry);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid slot registry entry for agent ${input.agentId}: ${issues}`);
  }

  const file = getSlotRegistryPath(repoPath, input.agentId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Serialize the ordered literal, not the parsed copy — zod re-keys objects.
  fs.writeFileSync(file, JSON.stringify(entry, null, 2) + '\n');
  if (input.notifyControl !== false) notifyControlSync(repoPath);
  return file;
}

/** Remove one slot's session entry and nudge Mission Control. */
export function removeSlotRegistry(
  repoPath: string,
  agentId: number,
  options: { notifyControl?: boolean } = {},
): void {
  fs.rmSync(getSlotRegistryPath(repoPath, agentId), { force: true });
  if (options.notifyControl !== false) notifyControlSync(repoPath);
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
