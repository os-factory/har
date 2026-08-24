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
