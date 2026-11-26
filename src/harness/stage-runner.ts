import * as fs from 'fs';
import * as path from 'path';
import { resolveTemplatesDir } from '../utils/paths';
import { computeFileChecksum, getHarnessDir, readManifest } from './manifest';

/**
 * The verify stage runner (#231) is package runtime, not harness config.
 *
 * HAR runs its own packaged copy. The only exception is an ejected harness
 * (`har env eject`, recorded as `ejected: true` in .har/manifest.json): it owns
 * `.har/lib/verify-runner.mjs`, and verify runs that copy.
 *
 * Releases before 2.0 scaffolded the runner into `.har/lib/` and preferred that
 * copy, so a repository set up by 1.x carries a committed copy that no longer
 * runs (it has no stage-log capture). Doctor reports it; `har env maintain`
 * removes it when it is a stock copy.
 */

/** The runner's path inside .har/ (ejected harnesses only). */
export const HARNESS_RUNNER_FILE = path.join('lib', 'verify-runner.mjs');

/**
 * Checksums (computeFileChecksum) of every runner HAR ever scaffolded into
 * `.har/lib/` (1.0.0 through 2.0.0-next.5). A copy matching one of them is
 * stock and safe to remove; anything else was edited by hand.
 */
export const STOCK_RUNNER_CHECKSUMS: readonly string[] = [
  '382266eaf701e63d',
  '42f6ba565d51b854',
  '015f3ec85247b987',
  '0f452cbb6c3fa55c',
];

/** The runner shipped inside the package. */
export function packagedVerifyRunner(): string {
  return path.join(resolveTemplatesDir(), 'runtime', 'verify-runner.mjs');
}

/** True when the harness owns its runtime (`har env eject`). */
export function harnessIsEjected(repoPath: string): boolean {
  return readManifest(repoPath)?.ejected === true;
}

/**
 * The runner verify executes: the harness's own copy when the harness is
 * ejected and has one, else the packaged runner.
 */
export function resolveVerifyRunnerFor(repoPath: string): string {
  const installed = path.join(getHarnessDir(repoPath), HARNESS_RUNNER_FILE);
  if (harnessIsEjected(repoPath) && fs.existsSync(installed)) return installed;
  return packagedVerifyRunner();
}

export interface StaleRunnerCopy {
  /** Path relative to .har/. */
  file: string;
  /** False when the copy is one HAR scaffolded unchanged. */
  edited: boolean;
}

/** A `.har/lib/verify-runner.mjs` that verify ignores (harness not ejected), if any. */
export function findStaleRunnerCopy(repoPath: string): StaleRunnerCopy | null {
  const manifest = readManifest(repoPath);
  if (manifest?.ejected === true) return null;
  const installed = path.join(getHarnessDir(repoPath), HARNESS_RUNNER_FILE);
  if (!fs.existsSync(installed)) return null;
  const checksum = computeFileChecksum(fs.readFileSync(installed, 'utf8'));
  const recordedTemplate = manifest?.templateChecksums?.[HARNESS_RUNNER_FILE];
  const stock = STOCK_RUNNER_CHECKSUMS.includes(checksum) || checksum === recordedTemplate;
  return { file: HARNESS_RUNNER_FILE, edited: !stock };
}

/** Advisory doctor line for a stale copy; null when there is none. */
export function staleRunnerHint(copy: StaleRunnerCopy | null): string | null {
  if (!copy) return null;
  return copy.edited
    ? `.har/${copy.file} is edited but no longer runs: HAR runs its packaged stage runner ` +
        'unless the runtime is ejected. Delete the file, or run `har env eject` to own the runtime.'
    : `.har/${copy.file} is a stale copy from an older HAR and no longer runs ` +
        '(HAR runs its packaged stage runner). `har env maintain` removes it.';
}

/**
 * Remove a stock stale copy (and `.har/lib/` when it ends up empty). An edited
 * copy is kept: doctor tells the user what to do with it. Returns the removed
 * path relative to .har/, or null.
 */
export function removeStaleRunnerCopy(repoPath: string): string | null {
  const copy = findStaleRunnerCopy(repoPath);
  if (!copy || copy.edited) return null;
  const harnessDir = getHarnessDir(repoPath);
  fs.rmSync(path.join(harnessDir, copy.file), { force: true });
  removeEmptyLibDir(harnessDir);
  return copy.file;
}

/** Install the packaged runner as the harness's own copy (eject). */
export function vendorVerifyRunner(repoPath: string): string {
  const dest = path.join(getHarnessDir(repoPath), HARNESS_RUNNER_FILE);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(packagedVerifyRunner(), dest);
  fs.chmodSync(dest, 0o755);
  return dest;
}

/** Remove the harness's own runner copy, whatever its content (adopt). */
export function removeVendoredVerifyRunner(repoPath: string): boolean {
  const harnessDir = getHarnessDir(repoPath);
  const file = path.join(harnessDir, HARNESS_RUNNER_FILE);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  removeEmptyLibDir(harnessDir);
  return true;
}

function removeEmptyLibDir(harnessDir: string): void {
  const libDir = path.join(harnessDir, 'lib');
  if (fs.existsSync(libDir) && fs.readdirSync(libDir).length === 0) fs.rmdirSync(libDir);
}
