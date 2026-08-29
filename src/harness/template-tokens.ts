import { getHarPackageVersion } from '../core/package-version';

/**
 * Lifecycle wrappers 1.0 used to generate (#235) and #314 retires. Kept as
 * the prune/detect list — init/maintain never write these files. One shared
 * set covered every profile; `attach.sh` was pm2-only (#297).
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
 * Profile-only wrappers that used to ship with a runtime bundle (#297).
 * Still pruned on maintain when a leftover copy is a managed/ejected wrapper.
 */
export const PROFILE_SHIM_FILES = ['attach.sh'] as const;

/**
 * Every retired lifecycle wrapper, whichever bundle used to install it.
 * Use this — not RUNTIME_SHIM_FILES — for prune, migrate-delete, and leftover
 * `command` detection. Leaving attach.sh out is what let the 1.0 migration
 * delete agent-slot.sh while a vendored attach.sh still sourced it (#297).
 */
export const MANAGED_SHIM_FILES = [...RUNTIME_SHIM_FILES, ...PROFILE_SHIM_FILES] as const;

/**
 * Render template tokens into generated harness content.
 * `__PROJECT_NAME__` scopes per-repo resources. `__HAR_VERSION__` remains
 * substituted in any leftover content that still carries the token.
 */
export function substituteTemplateTokens(content: string, projectName: string): string {
  return content
    .replace(/__PROJECT_NAME__/g, projectName)
    .replace(/__HAR_VERSION__/g, getHarPackageVersion());
}
