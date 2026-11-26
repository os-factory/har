import * as fs from 'fs';
import * as path from 'path';
import {
  DESTINATION_REPOSITORY_CONTENT,
  DESTINATION_REPOSITORY_SCOPES,
  OTLP_SIGNALS,
  type DestinationRepository,
  type DestinationRepositoryContent,
  type DestinationRepositoryScope,
  type HarDestination,
  type OtelHookContentMode,
  type OtelHookScope,
  type OtlpSignal,
} from '../harness/schema';
import { canonicalizeControlRepoPath, resolveMainWorkingTree } from './control-repo-path';
import { readGitRemote, sanitizeGitRemoteUrl } from './git-remote';

/**
 * Per-repository scopes of a destination: which repositories it receives and
 * how much of each (`off` / `usage` / `outline` / `full`, and at `full` the
 * text as `none` / `redacted` / `masked` / `raw`).
 *
 * The scopes live on the destination entry (`repositories`) and drive both
 * channels: HAR's own records, proofs and evidence ({@link destinationAcceptsRepository})
 * and agent telemetry, which otel-hook filters per record from the destination's
 * `scopes` ({@link buildOtelHookScopes} is the one place that writes them).
 *
 * An `hq` destination is always scoped: without `repositories` it receives
 * nothing. Other destinations are unscoped unless they list repositories.
 */

/** OTLP signals each scope sends (intersected with the destination's own). */
export const SCOPE_SIGNALS: Readonly<Record<DestinationRepositoryScope, readonly OtlpSignal[]>> = {
  off: [],
  usage: ['traces', 'metrics'],
  outline: ['traces', 'logs', 'metrics'],
  full: ['traces', 'logs', 'metrics'],
};

/** otel-hook content mode for a `full` scope's content choice. */
export const CONTENT_MODE_FOR: Readonly<Record<DestinationRepositoryContent, OtelHookContentMode>> = {
  none: 'omit',
  redacted: 'redact',
  masked: 'mask',
  raw: 'raw',
};

/** Onboarding's wording, for prompts and listings. */
export const SCOPE_LABELS: Readonly<Record<DestinationRepositoryScope, string>> = {
  off: 'Off — send nothing',
  usage: 'Usage only — records, verification, tokens and cost',
  outline: 'Outline — plus every step and its timing, no text',
  full: 'Full trajectory — plus prompts, agent replies and tool output',
};

export const CONTENT_LABELS: Readonly<Record<DestinationRepositoryContent, string>> = {
  none: 'None — keep the text local',
  redacted: 'Redacted — the text, with secrets (keys, tokens, passwords) replaced',
  masked: 'Masked — every character masked: the shape of the text, not the words',
  raw: 'Raw — the text as the agent saw it',
};

export function isRepositoryScope(value: unknown): value is DestinationRepositoryScope {
  return typeof value === 'string' && (DESTINATION_REPOSITORY_SCOPES as readonly string[]).includes(value);
}

export function isRepositoryContent(value: unknown): value is DestinationRepositoryContent {
  return typeof value === 'string' && (DESTINATION_REPOSITORY_CONTENT as readonly string[]).includes(value);
}

/**
 * Repository key, the way otel-hook compares scopes: lowercased host and path,
 * no scheme, credentials, port, trailing slash or `.git`. Undefined for a
 * local path or anything that is not a repository URL.
 */
export function repositoryKey(reference: string | undefined): string | undefined {
  const raw = reference?.trim();
  if (!raw) return undefined;
  let host: string;
  let pathname: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'file:') return undefined;
      host = url.hostname;
      pathname = url.pathname;
    } catch {
      return undefined;
    }
  } else {
    const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(raw);
    if (scp) {
      host = scp[1];
      pathname = scp[2];
    } else if (/^[^/\s]+\.[^/\s]+\/.+/.test(raw)) {
      const slash = raw.indexOf('/');
      host = raw.slice(0, slash);
      pathname = raw.slice(slash);
    } else {
      return undefined;
    }
  }
  const cleaned = pathname.replace(/\/+$/, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!host || !cleaned || cleaned === '/') return undefined;
  return `${host}${cleaned.startsWith('/') ? '' : '/'}${cleaned}`.toLowerCase();
}

/** Whether the destination filters by repository. */
export function isScopedDestination(destination: Pick<HarDestination, 'preset' | 'repositories'>): boolean {
  return destination.repositories !== undefined || destination.preset === 'hq';
}

/** A repository as the user named it: a local checkout (path and its `origin`) or a URL. */
export interface RepositoryReference {
  path?: string;
  url?: string;
}

/**
 * The repository a directory belongs to: the main checkout's root (a linked
 * worktree and a harness in a subdirectory map to it). Undefined outside git.
 */
export function repositoryRoot(dir: string): string | undefined {
  const main = resolveMainWorkingTree(dir);
  if (!main) return undefined;
  try {
    return fs.realpathSync(main);
  } catch {
    return path.resolve(main);
  }
}

/** Resolve `--repo <path|url>`: an existing directory is a checkout, anything else must be a repository URL. */
export function resolveRepositoryReference(reference: string, cwd = process.cwd()): RepositoryReference {
  const trimmed = reference.trim();
  const local = path.resolve(cwd, trimmed);
  if (trimmed && fs.existsSync(local) && fs.statSync(local).isDirectory()) {
    const root = repositoryRoot(local);
    if (!root) throw new Error(`${local} is not inside a git repository`);
    const url = sanitizeGitRemoteUrl(readGitRemote(root));
    return { path: root, ...(url ? { url } : {}) };
  }
  const url = sanitizeGitRemoteUrl(trimmed) ?? (repositoryKey(trimmed) ? `https://${repositoryKey(trimmed)}` : undefined);
  if (!url) throw new Error(`"${reference}" is neither a local repository nor a repository URL`);
  return { url };
}

function sameRepository(entry: RepositoryReference, target: RepositoryReference): boolean {
  if (entry.path && target.path && canonicalizeControlRepoPath(entry.path) === canonicalizeControlRepoPath(target.path)) {
    return true;
  }
  const a = repositoryKey(entry.url);
  return a !== undefined && a === repositoryKey(target.url);
}

/** A harness in a subdirectory (`control/.har`) belongs to the repository that contains it. */
function containsPath(root: string | undefined, child: string | undefined): boolean {
  if (!root || !child) return false;
  const relative = path.relative(canonicalizeControlRepoPath(root), child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** What a send is about: a local checkout, a repository URL, or both. */
export interface RepositoryTarget {
  repoPath?: string;
  repositoryUrl?: string;
}

function targetReference(target: RepositoryTarget): RepositoryReference {
  const repoPath = target.repoPath ? canonicalizeControlRepoPath(target.repoPath) : undefined;
  const url = target.repositoryUrl ?? (repoPath ? sanitizeGitRemoteUrl(readGitRemote(repoPath)) : undefined);
  return { ...(repoPath ? { path: repoPath } : {}), ...(url ? { url } : {}) };
}

/** The destination's entry for a repository, if it lists it. */
export function findRepositoryEntry(
  destination: Pick<HarDestination, 'repositories'>,
  target: RepositoryTarget,
): DestinationRepository | undefined {
  const entries = destination.repositories ?? [];
  if (entries.length === 0 || (!target.repoPath && !target.repositoryUrl)) return undefined;
  const reference = targetReference(target);
  return entries.find((entry) => sameRepository(entry, reference) || containsPath(entry.path, reference.path));
}

/**
 * Whether a scoped destination takes HAR's records, proofs and evidence for
 * this repository: listed at a scope other than `off`. Unscoped destinations
 * take everything; a scoped one takes nothing that names no repository.
 */
export function destinationAcceptsRepository(destination: HarDestination, target: RepositoryTarget): boolean {
  if (!isScopedDestination(destination)) return true;
  const entry = findRepositoryEntry(destination, target);
  return entry !== undefined && entry.scope !== 'off';
}

/** Whether a scoped destination takes an OTLP signal for a repository URL (unscoped: its own signals decide). */
export function destinationAcceptsSignal(
  destination: HarDestination,
  signal: OtlpSignal,
  target: RepositoryTarget,
): boolean {
  if (!destination.signals.includes(signal)) return false;
  if (!isScopedDestination(destination)) return true;
  const entry = findRepositoryEntry(destination, target);
  return entry !== undefined && SCOPE_SIGNALS[entry.scope].includes(signal);
}

/** otel-hook content mode of one entry. */
export function entryContentMode(entry: Pick<DestinationRepository, 'scope' | 'content'>): OtelHookContentMode {
  return entry.scope === 'full' ? CONTENT_MODE_FOR[entry.content ?? 'none'] : 'omit';
}

/**
 * The destination's otel-hook `scopes` — the one function that writes them.
 * Undefined: unscoped (every record goes). Empty: scoped but nothing to send
 * (the destination is then left out of the hook config). Repositories without
 * a URL cannot be matched by otel-hook, so their agent telemetry is not sent.
 * Signals are intersected with the destination's; entries with the same
 * signals and content mode share one scope.
 */
export function buildOtelHookScopes(
  destination: Pick<HarDestination, 'preset' | 'repositories' | 'signals' | 'includeSessionId'>,
): OtelHookScope[] | undefined {
  if (!isScopedDestination(destination)) return undefined;
  const groups = new Map<string, { scope: Omit<OtelHookScope, 'repositories'>; repositories: string[] }>();
  const seen = new Set<string>();
  for (const entry of destination.repositories ?? []) {
    const key = repositoryKey(entry.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const signals = OTLP_SIGNALS.filter(
      (signal) => SCOPE_SIGNALS[entry.scope].includes(signal) && destination.signals.includes(signal),
    );
    if (signals.length === 0) continue;
    const contentMode = entryContentMode(entry);
    const scope: Omit<OtelHookScope, 'repositories'> = {
      signals,
      contentMode,
      ...(destination.includeSessionId === false ? { includeSessionId: false } : {}),
    };
    const groupKey = JSON.stringify(scope);
    const group = groups.get(groupKey) ?? { scope, repositories: [] };
    group.repositories.push(key);
    groups.set(groupKey, group);
  }
  return [...groups.values()].map((group) => ({ repositories: group.repositories, ...group.scope }));
}

/** Add or update repositories (matched by path or URL). Returns the updated destination. */
export function upsertRepositories(
  destination: HarDestination,
  entries: readonly DestinationRepository[],
): HarDestination {
  const next = [...(destination.repositories ?? [])];
  for (const entry of entries) {
    const index = next.findIndex((existing) => sameRepository(existing, entry));
    const merged: DestinationRepository = {
      ...(index >= 0 ? next[index] : {}),
      ...entry,
    };
    if (merged.scope !== 'full') delete merged.content;
    if (index >= 0) next[index] = merged;
    else next.push(merged);
  }
  return { ...destination, repositories: next };
}

/** Remove repositories (matched by path or URL). Returns the destination and how many were removed. */
export function removeRepositories(
  destination: HarDestination,
  references: readonly RepositoryReference[],
): { destination: HarDestination; removed: number } {
  const before = destination.repositories ?? [];
  const after = before.filter((entry) => !references.some((reference) => sameRepository(entry, reference)));
  return { destination: { ...destination, repositories: after }, removed: before.length - after.length };
}

/** One line per repository: `<path or url>  <scope>[, text <content>]`. */
export function describeRepositoryEntry(entry: DestinationRepository): string {
  const name = entry.path ?? entry.url ?? '?';
  const detail =
    entry.scope === 'full' ? `full (text: ${entry.content ?? 'none'})` : entry.scope;
  const noUrl = !entry.url && entry.scope !== 'off' ? ' — no origin remote: records only, no agent telemetry' : '';
  return `${name}  ${detail}${noUrl}`;
}

/**
 * Whether an OTLP copy about `repositoryUrl` may go to a destination with these
 * otel-hook scopes (HAR's own OTLP, e.g. verification traces, applies the same
 * rule as otel-hook): unscoped → yes; scoped → the first scope listing the
 * repository must include the signal; no repository → no.
 */
export function otelScopesAllow(
  scopes: readonly OtelHookScope[] | undefined,
  repositoryUrl: string | undefined,
  signal: OtlpSignal,
): boolean {
  if (scopes === undefined) return true;
  const key = repositoryKey(repositoryUrl);
  if (!key) return false;
  const match = scopes.find(
    (scope) => scope.repositories === '*' || scope.repositories.some((entry) => repositoryKey(entry) === key),
  );
  return match !== undefined && (match.signals ?? OTLP_SIGNALS).includes(signal);
}
