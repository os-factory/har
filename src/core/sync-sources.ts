import * as path from 'path';
import { resolveHarnessRoot } from '../harness/manifest';
import {
  RunRecord,
  ValidationBindingRecord,
  ValidationRecord,
  WorkAttemptRecord,
  WorkUnitRecord,
} from '../harness/schema';
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
