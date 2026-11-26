import * as fs from 'fs';
import * as path from 'path';
import type {
  DestinationRepository,
  DestinationRepositoryContent,
  DestinationRepositoryScope,
  HarDestination,
} from '../harness/schema';
import { listRegisteredRepos } from './control-registry';
import {
  findRepositoryEntry,
  removeRepositories,
  repositoryRoot,
  upsertRepositories,
  type RepositoryReference,
} from './destination-scopes';
import { readGitRemote, sanitizeGitRemoteUrl } from './git-remote';
import { refreshAgentTelemetryRoute } from './otel-hooks';
import {
  addDestination,
  buildHqDestination,
  defaultHqIngestBaseUrl,
  readDestinations,
} from './telemetry-destinations';

/**
 * Which repositories HAR HQ receives, and how much of each: the `repositories`
 * of the `hq` destination (see `destination-scopes.ts`). `har hq connect`
 * asks, `har hq repos add|remove` edits. A repository that is not listed is
 * not sent, including one registered after login.
 */

/** The `hq` destination: the enabled one first, else the first one. */
export function hqDestination(list: readonly HarDestination[]): HarDestination | undefined {
  const hq = list.filter((destination) => destination.preset === 'hq');
  return hq.find((destination) => destination.enabled) ?? hq[0];
}

/** The repositories HAR HQ receives (every listed entry, `off` included). */
export function listHqRepositories(env: NodeJS.ProcessEnv = process.env): DestinationRepository[] {
  return hqDestination(readDestinations(env).destinations)?.repositories ?? [];
}

/** A repository the user picks a scope for. */
export interface HqRepositoryChoice {
  reference: RepositoryReference;
  scope: DestinationRepositoryScope;
  content?: DestinationRepositoryContent;
}

export interface HqRepositoriesWrite {
  destination: HarDestination;
  /** The destination did not exist and was added. */
  created: boolean;
  entries: DestinationRepository[];
}

function toEntry(choice: HqRepositoryChoice): DestinationRepository {
  return {
    ...(choice.reference.path ? { path: choice.reference.path } : {}),
    ...(choice.reference.url ? { url: choice.reference.url } : {}),
    scope: choice.scope,
    ...(choice.scope === 'full' ? { content: choice.content ?? 'none' } : {}),
  };
}

function writeHq(destination: HarDestination, env: NodeJS.ProcessEnv): void {
  addDestination(destination, { replace: true, env });
  // The hook picks the new scopes up on its next event.
  refreshAgentTelemetryRoute();
}

/**
 * Add or update repositories of the `hq` destination (added, enabled, when
 * missing). Throws when HAR HQ's ingest URL is unknown (not logged in).
 */
export function chooseHqRepositories(
  choices: readonly HqRepositoryChoice[],
  env: NodeJS.ProcessEnv = process.env,
): HqRepositoriesWrite {
  const existing = hqDestination(readDestinations(env).destinations);
  let base = existing;
  if (!base) {
    const baseUrl = defaultHqIngestBaseUrl(env);
    if (!baseUrl) {
      throw new Error('HAR HQ ingest URL unknown: log in first (har hq connect), or set HAR_HQ_INGEST_URL');
    }
    base = { ...buildHqDestination({ baseUrl }), repositories: [] };
  }
  const entries = choices.map(toEntry);
  const destination = { ...upsertRepositories(base, entries), enabled: true };
  writeHq(destination, env);
  return { destination, created: existing === undefined, entries };
}

/** Remove repositories from the `hq` destination. Returns how many were listed. */
export function removeHqRepositories(
  references: readonly RepositoryReference[],
  env: NodeJS.ProcessEnv = process.env,
): number {
  const existing = hqDestination(readDestinations(env).destinations);
  if (!existing) return 0;
  const { destination, removed } = removeRepositories(existing, references);
  if (removed > 0) writeHq(destination, env);
  return removed;
}

/**
 * After a login: point the `hq` destination at the logged-in org's ingest URL,
 * and forget the chosen repositories when the login switched org (they were
 * chosen for the previous one). Returns the repositories it forgot.
 */
export function alignHqDestinationAfterLogin(
  options: { switchedOrg: boolean; env?: NodeJS.ProcessEnv },
): DestinationRepository[] {
  const env = options.env ?? process.env;
  const existing = hqDestination(readDestinations(env).destinations);
  if (!existing) return [];
  const baseUrl = defaultHqIngestBaseUrl(env) ?? existing.baseUrl;
  const forgotten = options.switchedOrg ? (existing.repositories ?? []) : [];
  if (baseUrl === existing.baseUrl && forgotten.length === 0) return [];
  writeHq({ ...existing, baseUrl, ...(options.switchedOrg ? { repositories: [] } : {}) }, env);
  return forgotten;
}

/** A repository offered at login. */
export interface HqRepositoryCandidate {
  path: string;
  url?: string;
  /** The repository the command runs in. */
  current: boolean;
  /** Its entry, when already chosen. */
  chosen?: DestinationRepository;
  /** Attached to the 1.x connection the upgrade logged out. */
  attachedIn1x: boolean;
  /** Pre-selected: current, attached in 1.x, or already chosen above `off`. */
  preselected: boolean;
}

/**
 * Registered and known repositories, for the login multi-select: the current
 * repository first, then the others; 1.x attachments and existing choices
 * pre-selected.
 */
export function hqRepositoryCandidates(
  currentRepo: string | null,
  options: { env?: NodeJS.ProcessEnv; attachedIn1x?: readonly string[]; registered?: readonly string[] } = {},
): HqRepositoryCandidate[] {
  const env = options.env ?? process.env;
  const destination = hqDestination(readDestinations(env).destinations);
  const attached = new Set((options.attachedIn1x ?? []).map((repo) => path.resolve(repo)));
  const current = currentRepo ? (repositoryRoot(currentRepo) ?? path.resolve(currentRepo)) : null;
  const paths = [
    ...(current ? [current] : []),
    ...(options.registered ?? listRegisteredRepos()),
    ...attached,
    ...(destination?.repositories ?? []).flatMap((entry) => (entry.path ? [entry.path] : [])),
  ];
  const seen = new Set<string>();
  const out: HqRepositoryCandidate[] = [];
  for (const raw of paths) {
    if (!fs.existsSync(raw)) continue;
    // A harness in a subdirectory, or a linked worktree, is its repository.
    const repoPath = repositoryRoot(raw) ?? path.resolve(raw);
    if (seen.has(repoPath)) continue;
    seen.add(repoPath);
    const url = sanitizeGitRemoteUrl(readGitRemote(repoPath));
    const chosen = destination ? findRepositoryEntry(destination, { repoPath, ...(url ? { repositoryUrl: url } : {}) }) : undefined;
    const isCurrent = repoPath === current;
    const attachedIn1x = attached.has(repoPath) || attached.has(path.resolve(raw));
    out.push({
      path: repoPath,
      ...(url ? { url } : {}),
      current: isCurrent,
      ...(chosen ? { chosen } : {}),
      attachedIn1x,
      preselected: chosen ? chosen.scope !== 'off' : isCurrent || attachedIn1x,
    });
  }
  return out;
}

/**
 * The scope pre-selected at login: what 1.x sent (the outline, plus the text
 * when it forwarded the trajectory), else `usage`.
 */
export function defaultHqScope(
  defaults: { trajectoryForwarding: boolean } | undefined,
): { scope: DestinationRepositoryScope; content: DestinationRepositoryContent } {
  if (!defaults) return { scope: 'usage', content: 'none' };
  return defaults.trajectoryForwarding ? { scope: 'full', content: 'raw' } : { scope: 'outline', content: 'none' };
}
