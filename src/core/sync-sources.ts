import * as path from 'path';
import { resolveHarnessRoot } from '../harness/manifest';
import { RunRecord, WorkAttemptRecord, WorkUnitRecord } from '../harness/schema';
import { listRuns } from './runs';
import { listWorkAttempts, listWorkUnits } from './work-units';

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
  if (!workspacePath) return [canonical];

  const workspace = path.resolve(workspacePath);
  if (workspace === canonical) return [canonical];

  // Distinct harness roots only — a subdirectory of the same checkout resolves
  // to the same `.har` and would just duplicate every read.
  const canonicalRoot = resolveHarnessRoot(canonical);
  const workspaceRoot = resolveHarnessRoot(workspace);
  if (path.resolve(canonicalRoot) === path.resolve(workspaceRoot)) return [canonical];

  // Canonical first: it wins any id collision.
  return [canonical, workspace];
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
  return mergeById(
    sourcePaths.map((source) => listRuns(source)),
    (run) => run.runId,
  ).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
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
