import * as path from 'path';

function stripTrailingSeparators(value: string): string {
  return value.replace(/[/\\]+$/, '');
}

/** True when `workspace` equals `basePath` or is a subdirectory of it (not the reverse). */
export function isWorkspaceUnderPath(workspace: string, basePath: string): boolean {
  const workspaceNorm = stripTrailingSeparators(path.resolve(workspace));
  const baseNorm = stripTrailingSeparators(path.resolve(basePath));
  if (!workspaceNorm || !baseNorm) return false;
  return workspaceNorm === baseNorm || workspaceNorm.startsWith(`${baseNorm}${path.sep}`);
}

export function workspaceMatchesTarget(workspace: string, targets: string[]): boolean {
  return targets.some((target) => isWorkspaceUnderPath(workspace, target));
}
