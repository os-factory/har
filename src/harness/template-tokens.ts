import { getHarPackageVersion } from '../core/package-version';

/**
 * Generated `.har/*.sh` shims (#235) — thin delegates to `har env <op>` with a
 * pinned `npx @osfactory/har@<version>` fallback. One shared template set in
 * runtime-bundles/shared-kernel serves every profile.
 */
export const RUNTIME_SHIM_FILES = [
  'launch.sh',
  'verify.sh',
  'teardown.sh',
  'setup-infra.sh',
  'preflight.sh',
  'agent-cli.sh',
] as const;

/**
 * Shims a profile installs only when its bundle provides them (#297).
 * `attach.sh` ships with the pm2 runtime bundle; cli/ios profiles have no
 * managed processes to attach to and never install it.
 */
export const PROFILE_SHIM_FILES = ['attach.sh'] as const;

/**
 * Every managed `.har/*.sh` shim, whichever bundle installs it. Use this —
 * not RUNTIME_SHIM_FILES — for anything that asks "is this file on disk a
 * managed shim?": migration, drift ownership, eject/adopt, doctor. Leaving
 * attach.sh out of that question is what let the 1.0 migration delete
 * agent-slot.sh while a vendored attach.sh still sourced it (#297).
 */
export const MANAGED_SHIM_FILES = [...RUNTIME_SHIM_FILES, ...PROFILE_SHIM_FILES] as const;

/**
 * Render template tokens into generated harness content.
 * `__PROJECT_NAME__` scopes per-repo resources; `__HAR_VERSION__` pins the
 * shims' npx fallback to the package version that generated them, so a raw
 * `./.har/<shim>.sh` run is deterministic even with no har install around.
 */
export function substituteTemplateTokens(content: string, projectName: string): string {
  return content
    .replace(/__PROJECT_NAME__/g, projectName)
    .replace(/__HAR_VERSION__/g, getHarPackageVersion());
}
