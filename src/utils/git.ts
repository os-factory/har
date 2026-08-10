import { run } from './shell';

/**
 * Absolute root of the git checkout containing `cwd`, or undefined when `cwd` is
 * not inside one. Never throws — callers treat "not a checkout" as a normal state.
 */
export function resolveCheckoutRoot(cwd: string): string | undefined {
  const result = run('git rev-parse --show-toplevel', { cwd });
  if (result.code !== 0) return undefined;
  return result.stdout.trim() || undefined;
}
