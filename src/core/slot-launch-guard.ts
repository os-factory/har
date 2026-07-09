import { inspectSlotReadiness, formatPreflightReport } from './slot-preflight';
import { checkLaunchGuard as checkOccupiedSlotGuard, type LaunchGuardOptions } from './slot-launch-guard-occupied';
import type { AgentSlotStatus, SlotReadiness } from '../harness/schema';

export type { LaunchGuardOptions };

export interface LaunchGuardResult {
  allowed: boolean;
  blocked?: boolean;
  reason?: string;
  slot?: AgentSlotStatus;
  readiness?: SlotReadiness;
}

/** Preflight before launch: occupied-slot guard plus machine readiness (ports, PM2, Docker). */
export function checkLaunchGuard(
  repoPath: string,
  agentId: number,
  options: LaunchGuardOptions = {},
): LaunchGuardResult {
  const readiness = inspectSlotReadiness(repoPath, agentId, options);

  if (!readiness.canLaunch) {
    return {
      allowed: false,
      blocked: true,
      reason: formatPreflightReport(agentId, readiness),
      slot: checkOccupiedSlotGuard(repoPath, agentId, options).slot,
      readiness,
    };
  }

  const occupied = checkOccupiedSlotGuard(repoPath, agentId, options);
  return { allowed: true, slot: occupied.slot, readiness };
}
