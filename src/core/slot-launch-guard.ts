import { collectEnvironmentStatus } from './slot-status';
import type { AgentSlotStatus } from '../harness/schema';

export interface LaunchGuardOptions {
  confirmReplace?: boolean;
  force?: boolean;
}

export interface LaunchGuardResult {
  allowed: boolean;
  /** Set when launch is blocked because the slot is already in use. */
  blocked?: boolean;
  reason?: string;
  slot?: AgentSlotStatus;
}

function formatOccupiedSlot(slot: AgentSlotStatus): string {
  const lines = [
    `Slot ${slot.agentId} is already in use.`,
    slot.worktreePath ? `  Worktree: ${slot.worktreePath}` : undefined,
    slot.branch ? `  Branch:   ${slot.branch}` : undefined,
    slot.workDir ? `  Work dir: ${slot.workDir}` : undefined,
    slot.sessionCreatedAt ? `  Since:    ${slot.sessionCreatedAt}` : undefined,
    slot.dirty
      ? '  Git:      dirty (uncommitted changes — commit or use force to discard)'
      : '  Git:      clean',
    '',
    'Replacing removes the worktree. The session branch is kept only if you committed.',
    'Gitignored paths (state/, runs/, local clones) are NOT preserved.',
    '',
    'To replace: pass confirmReplace=true (MCP), --replace (CLI), or answer y at the prompt.',
    'If the worktree is dirty, also pass force=true / --force after explicit user approval.',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * Preflight before launch: refuse to replace an occupied slot unless the caller
 * explicitly confirms. Dirty worktrees additionally require force.
 */
export function checkLaunchGuard(
  repoPath: string,
  agentId: number,
  options: LaunchGuardOptions = {},
): LaunchGuardResult {
  const status = collectEnvironmentStatus(repoPath);
  const slot = status.slots.find((s) => s.agentId === agentId);
  if (!slot?.active) {
    return { allowed: true };
  }

  if (!options.confirmReplace) {
    return {
      allowed: false,
      blocked: true,
      slot,
      reason: formatOccupiedSlot(slot),
    };
  }

  if (slot.dirty && !options.force) {
    return {
      allowed: false,
      blocked: true,
      slot,
      reason: [
        formatOccupiedSlot(slot),
        '',
        'The occupied worktree has uncommitted changes.',
        'Pass force=true / --force to discard them (only after explicit user approval).',
      ].join('\n'),
    };
  }

  return { allowed: true, slot };
}
