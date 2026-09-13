import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_HAR_DIR, resolveHarnessRoot } from '../harness/manifest';
import {
  AgentSlotStatus,
  RunRecord,
  ValidationBindingRecord,
  ValidationCommitBinding,
  ValidationRecord,
  WorkAttemptRecord,
  WorkUnitRecord,
} from '../harness/schema';
import { listCommitBindings } from './commit-bindings';
import { listLinkedWorktrees } from './control-repo-path';
import { listRuns } from './runs';
import { listValidations } from './validations';
import { listValidationBindings, listWorkAttempts, listWorkUnits } from './work-units';

/**
 * Where one sync reads its on-disk evidence from (#255).
 *
 * Repository *identity* is canonical: every worktree of a repo maps to the main
 * checkout, so Mission Control keeps one repository row instead of one per
 * worktree. That canonicalization is deliberate and stays.
 *
 * Its side effect was that evidence written somewhere else was never read. HAR
 * writes run records for its own session worktrees into the main checkout, so
 * canonical is the right source there. But an in-place launch inside a worktree
 * HAR did not create resolves its harness root to that workspace and writes
 * everything there — records that canonical-only reads never see.
 *
 * Reading the union of both covers each case without choosing between them: for
 * a HAR-owned worktree the workspace holds no records and the union is exactly
 * what canonical already returned.
 */
export function resolveSyncSourcePaths(canonicalPath: string, workspacePath?: string): string[] {
  const canonical = path.resolve(canonicalPath);
  const paths: string[] = [canonical];
  const seenRoots = new Set([path.resolve(resolveHarnessRoot(canonical))]);

  const add = (candidate: string): void => {
    const resolved = path.resolve(candidate);
    const root = path.resolve(resolveHarnessRoot(resolved));
    if (seenRoots.has(root)) return;
    seenRoots.add(root);
    paths.push(resolved);
  };

  if (workspacePath) add(workspacePath);

  // Sibling linked worktrees that store their own evidence (#256). A HAR-owned
  // session worktree copies `.har/manifest.json` but writes runs/slots on the
  // main checkout, so it is skipped. An in-place launch inside an externally
  // owned worktree writes into that workspace's `.har` and must be read even
  // when sync was invoked from the canonical checkout.
  for (const worktree of listLinkedWorktrees(canonical)) {
    if (hasHarnessEvidence(worktree)) add(worktree);
  }

  return paths;
}

const EVIDENCE_SUBDIRS = ['slots', 'runs', 'work-units', 'validations'] as const;

/** Whether this checkout's `.har/` holds records (not just a copied manifest). */
export function hasHarnessEvidence(repoPath: string): boolean {
  const root = resolveHarnessRoot(repoPath);
  const harDir = path.join(root, DEFAULT_HAR_DIR);
  if (!fs.existsSync(harDir)) return false;
  for (const sub of EVIDENCE_SUBDIRS) {
    const dir = path.join(harDir, sub);
    if (!fs.existsSync(dir)) continue;
    try {
      if (fs.readdirSync(dir).length > 0) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/**
 * One status row per slot number.
 *
 * Mission Control keeps a single AgentSlot per `(repository, slotId)` — that is
 * the live occupancy of the workstation (#316). Concurrent in-place launches
 * of the same number (N external workspaces each on "slot 1") cannot all be
 * that row. Prefer any active occupancy over idle so a canonical idle report
 * cannot wipe a live external session (#256); when two occupancies are both
 * active, the newer `sessionCreatedAt` is the one the slot page shows.
 */
export function mergeSlotStatuses(groups: AgentSlotStatus[][]): AgentSlotStatus[] {
  const byId = new Map<number, AgentSlotStatus>();
  for (const group of groups) {
    for (const slot of group) {
      const existing = byId.get(slot.agentId);
      byId.set(slot.agentId, existing ? preferSlotStatus(existing, slot) : slot);
    }
  }
  return [...byId.values()].sort((a, b) => a.agentId - b.agentId);
}

function preferSlotStatus(a: AgentSlotStatus, b: AgentSlotStatus): AgentSlotStatus {
  if (a.active !== b.active) return a.active ? a : b;
  const aCreated = a.sessionCreatedAt ?? '';
  const bCreated = b.sessionCreatedAt ?? '';
  if (aCreated !== bCreated) return aCreated >= bCreated ? a : b;
  const aRun = a.lastRunAt ?? '';
  const bRun = b.lastRunAt ?? '';
  if (aRun !== bRun) return aRun >= bRun ? a : b;
  return a;
}

/** Merge per-source lists, first occurrence of an id winning. */
function mergeById<T>(groups: T[][], id: (item: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const group of groups) {
    for (const item of group) {
      const key = id(item);
      if (!seen.has(key)) seen.set(key, item);
    }
  }
  return [...seen.values()];
}

/** Runs across every source, newest first (matching listRuns' ordering). */
export function collectRunsForSync(sourcePaths: string[]): RunRecord[] {
  return mergeRunsBySource(collectRunsBySource(sourcePaths));
}

/** Work units and attempts across every source, newest first. */
export function collectWorkUnitsForSync(sourcePaths: string[]): {
  workUnits: WorkUnitRecord[];
  attempts: WorkAttemptRecord[];
} {
  const roots = sourcePaths.map((source) => resolveHarnessRoot(source));
  return {
    workUnits: mergeById(
      roots.map((root) => listWorkUnits(root)),
      (unit) => unit.workUnitId,
    ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    attempts: mergeById(
      roots.map((root) => listWorkAttempts(root)),
      (attempt) => attempt.attemptId,
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  };
}

/** Runs kept per source, so a source new to a watermark can skip its filter. */
export interface RunsBySource {
  source: string;
  runs: RunRecord[];
}

export function collectRunsBySource(sourcePaths: string[]): RunsBySource[] {
  return sourcePaths.map((source) => ({ source, runs: listRuns(source) }));
}

/** Flatten per-source groups into the deduped, newest-first list. */
export function mergeRunsBySource(bySource: RunsBySource[]): RunRecord[] {
  return mergeById(
    bySource.map((group) => group.runs),
    (run) => run.runId,
  ).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/**
 * Runs to send, given what a watermark has already covered.
 *
 * A watermark records which sources it was advanced over. A source absent from
 * that list has never been synced to this target, so filtering its records by a
 * timestamp it never contributed to would strand them permanently — send all of
 * them once, and let the watermark cover it from then on. Legacy watermarks
 * carry no source list and are treated as covering the canonical path only.
 */
export function selectRunsForSync(
  bySource: RunsBySource[],
  since: string | null,
  coveredSources: string[],
  selectSince: (runs: RunRecord[], since: string | null) => RunRecord[],
): RunRecord[] {
  const covered = new Set(coveredSources.map((source) => path.resolve(source)));
  const groups = bySource.map(({ source, runs }) =>
    covered.has(path.resolve(source)) ? selectSince(runs, since) : runs,
  );
  return mergeById(groups, (run) => run.runId).sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
}

/** Validations across every source. */
export function collectValidationsForSync(sourcePaths: string[]): ValidationRecord[] {
  return mergeById(
    sourcePaths.map((source) => listValidations(resolveHarnessRoot(source))),
    (record) => record.validationId,
  );
}

/** Validation bindings across every source. */
export function collectValidationBindingsForSync(
  sourcePaths: string[],
): ValidationBindingRecord[] {
  return mergeById(
    sourcePaths.map((source) => listValidationBindings(resolveHarnessRoot(source))),
    (record) => record.bindingId,
  );
}

/** Commit bindings across every source. */
export function collectCommitBindingsForSync(
  sourcePaths: string[],
): ValidationCommitBinding[] {
  return mergeById(
    sourcePaths.map((source) => listCommitBindings(resolveHarnessRoot(source))),
    (record) => record.bindingId,
  );
}
