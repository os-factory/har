import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPrivacyService, DEFAULT_PRIVACY_POLICY, deriveWorkspaceIdentity } from '@osfactory/otel-hook/privacy';

/**
 * How otel-hook keyed an id: a session's `otelhook.workspace.id` hashes its
 * working directory; a tool target's `otelhook.target.workspace.id` and
 * `otelhook.target.repository.id` hash a git worktree root (otel-hook ADR 0008).
 */
export type OtelWorkspaceKeyKind = 'working-directory' | 'git-root';

// HAR installs otel-hook with its default privacy policy (empty salt).
const privacy = createPrivacyService(DEFAULT_PRIVACY_POLICY);

/**
 * otel-hook's own opaque id for a path, so Mission Control maps the ids it
 * receives back to registered paths without paths on the wire.
 */
export function otelWorkspaceIdForPath(absolutePath: string, kind: OtelWorkspaceKeyKind = 'working-directory'): string {
  return deriveWorkspaceIdentity(privacy, { kind, absolutePath }).workspaceId;
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

/** First path (longest preferred) whose opaque id of `kind` equals `workspaceId`. */
export function pickPathForWorkspaceId(
  workspaceId: string,
  candidatePaths: string[],
  kind: OtelWorkspaceKeyKind = 'working-directory',
): string | null {
  if (!workspaceId || workspaceId === 'unknown:0000000000000000') return null;
  const unique = [...new Set(candidatePaths.map(normalizeOtelPath).filter(Boolean))];
  // Prefer longer paths so worktree dirs win over the parent checkout.
  unique.sort((a, b) => b.length - a.length);
  for (const path of unique) {
    if (otelWorkspaceIdForPath(path, kind) === workspaceId) return path;
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

/** A path as written and, when it exists here, its real path (symlinks resolved). */
export function pathAsWrittenAndResolved(absolutePath: string): string[] {
  try {
    return [...new Set([absolutePath, fs.realpathSync(absolutePath)])];
  } catch {
    return [absolutePath];
  }
}
