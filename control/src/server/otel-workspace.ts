import { createHash } from 'node:crypto';
import * as path from 'node:path';

/**
 * Match @osfactory/otel-hook's default privacy hash (empty salt):
 *   sha256(salt + "\0" + `${namespace}\0${value}`)
 * with namespace `workspace/working-directory` and value = absolute path
 * (trailing slashes stripped). Used to map opaque `otelhook.workspace.id`
 * back to a registered repository path without storing filesystem paths in
 * OTLP payloads.
 */
export function otelWorkspaceIdForPath(absolutePath: string, hashSalt = ''): string {
  const material = absolutePath.replace(/[/\\]+$/, '');
  if (!material) return 'unknown:0000000000000000';
  const digest = createHash('sha256')
    .update(hashSalt)
    .update('\0')
    .update(`workspace/working-directory\0${material}`, 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

export function normalizeOtelPath(value: string): string {
  return value.replace(/[/\\]+$/, '');
}

/** True when `workspace` equals `basePath` or is a subdirectory of it (not the reverse). */
export function isWorkspaceUnderPath(workspace: string, basePath: string): boolean {
  const workspaceNorm = normalizeOtelPath(path.resolve(workspace));
  const baseNorm = normalizeOtelPath(path.resolve(basePath));
  if (!workspaceNorm || !baseNorm) return false;
  return workspaceNorm === baseNorm || workspaceNorm.startsWith(`${baseNorm}${path.sep}`);
}

/** Longest registered path that equals or is a parent of `workspace`. */
export function pickBestRepoPathMatch(
  workspace: string,
  repoPaths: string[],
): string | null {
  const normalized = normalizeOtelPath(workspace);
  if (!normalized) return null;
  const matches = repoPaths
    .map(normalizeOtelPath)
    .filter(
      (path) =>
        path.length > 0 &&
        (normalized === path || normalized.startsWith(`${path}/`)),
    )
    .sort((a, b) => b.length - a.length);
  return matches[0] ?? null;
}

/** First path (longest preferred) whose opaque workspace id equals `workspaceId`. */
export function pickPathForWorkspaceId(
  workspaceId: string,
  candidatePaths: string[],
  hashSalt = '',
): string | null {
  if (!workspaceId || workspaceId === 'unknown:0000000000000000') return null;
  const unique = [...new Set(candidatePaths.map(normalizeOtelPath).filter(Boolean))];
  // Prefer longer paths so worktree dirs win over the parent checkout.
  unique.sort((a, b) => b.length - a.length);
  for (const path of unique) {
    if (otelWorkspaceIdForPath(path, hashSalt) === workspaceId) return path;
  }
  return null;
}

export function shouldPersistOtelUsage(usage: {
  tokensTotal: number;
  costUsd?: number | null;
}): boolean {
  if (usage.tokensTotal > 0) return true;
  return typeof usage.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd > 0;
}
