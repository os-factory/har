import { spawnSync } from 'child_process';

/**
 * Package runners HAR can use to execute a one-off CLI (pm2 and friends),
 * in preference order, each with the flag that keeps it non-interactive.
 *
 * Mirrors `har_pkg_exec` in the harness templates: the CLI must not assume npm
 * is installed, since bun-only machines are common.
 */
const RUNNERS = ['npx --yes', 'bunx', 'pnpm dlx', 'yarn dlx'] as const;

let cached: string | undefined;

function commandExists(command: string): boolean {
  const result = spawnSync('sh', ['-c', `command -v ${JSON.stringify(command)}`], {
    encoding: 'utf8',
  });
  return result.status === 0 && Boolean(result.stdout?.trim());
}

/**
 * Returns the package-runner prefix to put in front of a package name, e.g.
 * `npx --yes` or `bunx`. Falls back to `npx --yes` when nothing is installed so
 * callers still produce a recognizable command in error messages.
 */
export function packageRunner(): string {
  if (cached !== undefined) return cached;
  const available = RUNNERS.find((runner) => commandExists(runner.split(' ')[0]));
  cached = available ?? RUNNERS[0];
  return cached;
}

/** Test seam — clears the memoized lookup. */
export function resetPackageRunnerCache(): void {
  cached = undefined;
}
