import * as fs from 'fs';
import * as path from 'path';
import type { HarnessScrubResult } from '@har/schemas';

/** Gitignored harness dirs that Mission Control syncs / re-ingests from. */
export const HARNESS_SCRUB_DIRS = ['runs', 'validations', 'state', 'slots'] as const;

/**
 * Best-effort removal of local harness history under `.har/`.
 * Inside the packaged Docker image host paths are usually invisible — those
 * targets are reported as not deleted so the CLI can finish the job.
 */
export function scrubLocalHarnessDirs(repoPath: string): HarnessScrubResult[] {
  const results: HarnessScrubResult[] = [];
  const resolved = path.resolve(repoPath);

  if (!fs.existsSync(resolved)) {
    for (const directory of HARNESS_SCRUB_DIRS) {
      results.push({
        path: path.join(resolved, '.har', directory),
        directory,
        deleted: false,
        error: 'repository path not visible to Mission Control (use har control reset)',
      });
    }
    return results;
  }

  for (const directory of HARNESS_SCRUB_DIRS) {
    const target = path.join(resolved, '.har', directory);
    if (!fs.existsSync(target)) {
      results.push({ path: target, directory, deleted: true });
      continue;
    }

    try {
      fs.rmSync(target, { recursive: true, force: true });
      results.push({
        path: target,
        directory,
        deleted: !fs.existsSync(target),
        error: fs.existsSync(target) ? 'failed to remove directory' : undefined,
      });
    } catch (err: unknown) {
      results.push({
        path: target,
        directory,
        deleted: !fs.existsSync(target),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return results;
}

export function scrubLocalHarnessForRepos(repoPaths: string[]): HarnessScrubResult[] {
  const results: HarnessScrubResult[] = [];
  const seen = new Set<string>();

  for (const repoPath of repoPaths) {
    const key = path.resolve(repoPath);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(...scrubLocalHarnessDirs(key));
  }

  return results;
}
