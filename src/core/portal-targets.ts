import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalizeControlRepoPath } from './control-repo-path';
import { listRegisteredRepos } from './control-registry';
import { readTelemetryPreference } from './telemetry-config';
import { markAllRegisteredDirty } from './sync-context';

/**
 * The CLI holds ONE HAR HQ (portal) org connection at a time. Every sync, OTel
 * and trajectory upload goes to that org only. Connecting to another org
 * replaces the connection and clears the attached repositories, so nothing is
 * sent to the previous org and no repository syncs to more than one org.
 */
export interface PortalTargetRecord {
  alias: string;
  portalUrl: string;
  /** Stable workspace/org id from the portal login callback. */
  workspaceId: string;
  workspaceName?: string;
  workspaceSlug?: string;
  token: string;
  refreshToken?: string;
  expiresAt?: string;
  email?: string;
  trajectoryForwarding?: boolean;
  createdAt: string;
  updatedAt?: string;
  lastUsedAt?: string;
}

/** The active org connection and the repositories that sync to it. */
export interface PortalConnectionState {
  connection: PortalTargetRecord | null;
  /** Canonical repo paths attached to {@link connection}. Empty when disconnected. */
  attachedRepos: string[];
}

/**
 * On-disk shape of `~/.har/portal-targets.json`. Kept readable by older CLIs
 * (which read `targets` / `defaultTarget` / `repoTargets`), but always written
 * with at most one target and every repo mapped to that target only.
 */
interface PortalTargetsFile {
  version: 1;
  defaultTarget?: string;
  targets: PortalTargetRecord[];
  repoTargets?: Record<string, string[]>;
}

export interface PortalTargetResolution {
  url: string;
  token: string;
  refreshToken?: string;
  alias?: string;
  workspaceId?: string;
  identityKey: string;
  email?: string;
}

/** `env`: HAR_PORTAL_URL + HAR_PORTAL_TOKEN override. `connection`: the saved org connection. */
export type PortalTargetSource = 'env' | 'connection';

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function normalizePortalUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function portalTargetIdentityKey(portalUrl: string, workspaceId: string): string {
  return `${normalizePortalUrl(portalUrl)}#${workspaceId}`;
}

function recordIdentityKey(record: PortalTargetRecord): string {
  return portalTargetIdentityKey(record.portalUrl, record.workspaceId);
}

export function portalTargetsPath(): string {
  if (process.env.HAR_PORTAL_TARGETS_PATH) {
    return path.resolve(process.env.HAR_PORTAL_TARGETS_PATH);
  }
  return path.join(os.homedir(), '.har', 'portal-targets.json');
}

function isRecord(entry: unknown): entry is PortalTargetRecord {
  const value = entry as Partial<PortalTargetRecord> | null | undefined;
  return (
    typeof value?.alias === 'string' &&
    typeof value?.portalUrl === 'string' &&
    typeof value?.workspaceId === 'string' &&
    typeof value?.token === 'string' &&
    typeof value?.createdAt === 'string'
  );
}

function recencyOf(record: PortalTargetRecord): number {
  const parsed = Date.parse(record.lastUsedAt ?? record.updatedAt ?? record.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Repos whose saved destination list names `alias` (older stores could list several). */
function reposAttachedTo(raw: unknown, alias: string): string[] {
  if (!raw || typeof raw !== 'object') return [];
  const repos: string[] = [];
  for (const [repoPath, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!repoPath) continue;
    const aliases = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
    if (aliases.some((entry) => typeof entry === 'string' && entry.trim().toLowerCase() === alias)) {
      repos.push(repoPath);
    }
  }
  return [...new Set(repos)];
}

/**
 * Collapse a stored file — including one from an older CLI that held several
 * org connections — to a single connection: `defaultTarget` when it still
 * exists, else the most recently used one. The other connections, their tokens
 * and their repo attachments are dropped.
 */
export function collapsePortalTargetsFile(raw: unknown): PortalConnectionState {
  const file = (raw ?? {}) as Partial<PortalTargetsFile>;
  const targets = Array.isArray(file.targets) ? file.targets.filter(isRecord) : [];
  if (targets.length === 0) return { connection: null, attachedRepos: [] };

  const byDefault =
    typeof file.defaultTarget === 'string'
      ? targets.find((entry) => entry.alias === file.defaultTarget)
      : undefined;
  const connection = byDefault ?? [...targets].sort((a, b) => recencyOf(b) - recencyOf(a))[0];
  return { connection, attachedRepos: reposAttachedTo(file.repoTargets, connection.alias) };
}

function toFile(state: PortalConnectionState): PortalTargetsFile {
  if (!state.connection) return { version: 1, targets: [] };
  const alias = state.connection.alias;
  const repos = [...new Set(state.attachedRepos)];
  return {
    version: 1,
    defaultTarget: alias,
    targets: [state.connection],
    ...(repos.length > 0
      ? { repoTargets: Object.fromEntries(repos.map((repoPath) => [repoPath, [alias]])) }
      : {}),
  };
}

function writeState(state: PortalConnectionState): void {
  const file = portalTargetsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(toFile(state), null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

const EMPTY_STATE: PortalConnectionState = { connection: null, attachedRepos: [] };

/** Read the active connection, collapsing (and persisting) a multi-connection store. */
export function readPortalConnectionState(): PortalConnectionState {
  migrateLegacyCredentialsIfNeeded();
  const file = portalTargetsPath();
  let raw: unknown;
  try {
    if (!fs.existsSync(file)) return { ...EMPTY_STATE };
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ...EMPTY_STATE };
  }

  const state = collapsePortalTargetsFile(raw);
  if (JSON.stringify(toFile(state)) !== JSON.stringify(raw)) {
    // Persist the collapse right away so the dropped connections' tokens leave disk.
    try {
      writeState(state);
      if (state.connection) syncLegacyCredentialsFile(state.connection);
    } catch {
      // Unwritable home: keep using the collapsed view in memory.
    }
  }
  return state;
}

export function getActivePortalConnection(): PortalTargetRecord | null {
  return readPortalConnectionState().connection;
}

export function listAttachedRepos(): string[] {
  return readPortalConnectionState().attachedRepos;
}

export function isRepoAttachedToPortal(repoPath: string): boolean {
  return readPortalConnectionState().attachedRepos.includes(canonicalizeControlRepoPath(repoPath));
}

export function resolveWorkspaceId(input: {
  workspaceId?: string;
  workspace?: string;
  workspaceSlug?: string;
  alias?: string;
}): string {
  if (input.workspaceId?.trim()) return input.workspaceId.trim();
  if (input.workspaceSlug?.trim()) return `slug:${input.workspaceSlug.trim()}`;
  if (input.workspace?.trim()) return `slug:${input.workspace.trim()}`;
  if (input.alias?.trim()) return `manual:${input.alias.trim()}`;
  return 'legacy:default';
}

export function deriveTargetAlias(input: {
  alias?: string;
  portalUrl: string;
  workspace?: string;
  workspaceSlug?: string;
  workspaceName?: string;
}): string {
  if (input.alias?.trim()) {
    const candidate = sanitizeAlias(input.alias.trim());
    if (!candidate) throw new Error('Target alias must be alphanumeric (dots, dashes, underscores allowed).');
    return candidate;
  }

  const slugBase =
    sanitizeAlias(input.workspaceSlug ?? input.workspace ?? '') ||
    sanitizeAlias(input.workspaceName ?? '') ||
    sanitizeAlias(new URL(input.portalUrl).hostname.replace(/\./g, '-'));

  return slugBase || 'default';
}

function sanitizeAlias(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (!normalized || !ALIAS_PATTERN.test(normalized)) return '';
  return normalized;
}

export function validateTargetAlias(alias: string): void {
  const sanitized = sanitizeAlias(alias);
  if (!sanitized || sanitized !== alias.trim().toLowerCase()) {
    throw new Error(
      'Target alias must start with a letter or number and contain only letters, numbers, dots, dashes, or underscores.',
    );
  }
}

export function recordToPortalTarget(record: PortalTargetRecord): PortalTargetResolution {
  return {
    url: normalizePortalUrl(record.portalUrl),
    token: record.token,
    refreshToken: record.refreshToken,
    alias: record.alias,
    workspaceId: record.workspaceId,
    identityKey: recordIdentityKey(record),
    email: record.email,
  };
}

export function redactPortalTargetRecord(record: PortalTargetRecord): Record<string, unknown> {
  return {
    alias: record.alias,
    portalUrl: normalizePortalUrl(record.portalUrl),
    workspaceId: record.workspaceId,
    workspaceName: record.workspaceName,
    workspaceSlug: record.workspaceSlug,
    email: record.email,
    trajectoryForwarding: record.trajectoryForwarding === true,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastUsedAt: record.lastUsedAt,
    hasRefreshToken: Boolean(record.refreshToken),
    expiresAt: record.expiresAt,
  };
}

export interface ConnectPortalResult {
  record: PortalTargetRecord;
  /** The different org this connection replaced; null on first connect or same-org reconnect. */
  replaced: PortalTargetRecord | null;
  /** Repos that stopped syncing because the org changed. */
  detachedRepos: string[];
}

/**
 * Make this org the CLI's one connection. Reconnecting to the same org refreshes
 * its tokens and keeps its attached repos; connecting to a different org
 * replaces the connection and clears the attached repos.
 */
export function connectPortal(input: {
  alias?: string;
  portalUrl: string;
  workspaceId?: string;
  workspace?: string;
  workspaceSlug?: string;
  workspaceName?: string;
  token: string;
  refreshToken?: string;
  expiresAt?: string;
  email?: string;
  trajectoryForwarding?: boolean;
}): ConnectPortalResult {
  const current = readPortalConnectionState();
  const workspaceId = resolveWorkspaceId(input);
  const sameOrg =
    current.connection !== null &&
    recordIdentityKey(current.connection) === portalTargetIdentityKey(input.portalUrl, workspaceId);
  const previous = sameOrg ? current.connection : null;

  const alias = deriveTargetAlias({
    alias: input.alias ?? previous?.alias,
    portalUrl: input.portalUrl,
    workspace: input.workspace,
    workspaceSlug: input.workspaceSlug,
    workspaceName: input.workspaceName,
  });
  validateTargetAlias(alias);

  const now = new Date().toISOString();
  const record: PortalTargetRecord = {
    alias,
    portalUrl: normalizePortalUrl(input.portalUrl),
    workspaceId,
    workspaceName: input.workspaceName ?? input.workspace,
    workspaceSlug: input.workspaceSlug ?? input.workspace,
    token: input.token,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    email: input.email,
    trajectoryForwarding: input.trajectoryForwarding ?? previous?.trajectoryForwarding ?? false,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: now,
  };

  writeState({ connection: record, attachedRepos: sameOrg ? current.attachedRepos : [] });
  syncLegacyCredentialsFile(record);
  markAllRegisteredDirty();
  return {
    record,
    replaced: sameOrg ? null : current.connection,
    detachedRepos: sameOrg ? [] : current.attachedRepos,
  };
}

/**
 * Persist a rotated ingest token. Ignored unless `identityKey` still names the
 * active connection, so a refresh that lands after an org switch cannot
 * overwrite the new org's credential.
 */
export function updatePortalTargetTokens(
  identityKey: string,
  tokens: { token: string; refreshToken?: string; expiresAt?: string },
): PortalTargetRecord | null {
  const state = readPortalConnectionState();
  const current = state.connection;
  if (!current || recordIdentityKey(current) !== identityKey) return null;
  const next: PortalTargetRecord = {
    ...current,
    token: tokens.token,
    refreshToken: tokens.refreshToken ?? current.refreshToken,
    expiresAt: tokens.expiresAt ?? current.expiresAt,
    updatedAt: new Date().toISOString(),
  };
  writeState({ ...state, connection: next });
  syncLegacyCredentialsFile(next);
  return next;
}

/** Remove the connection and every repo attachment. Returns the removed connection. */
export function disconnectPortal(): PortalTargetRecord | null {
  const { connection } = readPortalConnectionState();
  if (!connection) return null;
  writeState({ ...EMPTY_STATE });
  removeLegacyCredentialsFile();
  markAllRegisteredDirty();
  return connection;
}

/** Attach a repo to the active connection. Throws when there is no connection. */
export function attachRepoToPortal(repoPath: string): PortalTargetRecord {
  const state = readPortalConnectionState();
  if (!state.connection) throw new Error('No HAR HQ connection — run har hq connect first.');
  const canonical = canonicalizeControlRepoPath(repoPath);
  if (!state.attachedRepos.includes(canonical)) {
    writeState({ ...state, attachedRepos: [...state.attachedRepos, canonical] });
  }
  return state.connection;
}

export function detachRepoFromPortal(repoPath: string): boolean {
  const state = readPortalConnectionState();
  const canonical = canonicalizeControlRepoPath(repoPath);
  if (!state.attachedRepos.includes(canonical)) return false;
  writeState({
    ...state,
    attachedRepos: state.attachedRepos.filter((entry) => entry !== canonical),
  });
  return true;
}

export function displayPortalTargetLabel(record: PortalTargetRecord): string {
  let host = record.portalUrl;
  try {
    host = new URL(record.portalUrl).host;
  } catch {
    host = record.portalUrl;
  }
  const workspace =
    record.workspaceName ||
    record.workspaceSlug ||
    (record.workspaceId.startsWith('legacy:') ||
    record.workspaceId.startsWith('manual:') ||
    record.workspaceId.startsWith('slug:')
      ? undefined
      : record.workspaceId);
  return workspace ? `${workspace} @ ${host}` : host;
}

function envPortalTarget(): PortalTargetResolution | null {
  if (!process.env.HAR_PORTAL_URL || !process.env.HAR_PORTAL_TOKEN) return null;
  const url = normalizePortalUrl(process.env.HAR_PORTAL_URL);
  return { url, token: process.env.HAR_PORTAL_TOKEN, identityKey: url };
}

/**
 * The one org a run sends to. `HAR_PORTAL_URL` + `HAR_PORTAL_TOKEN` override
 * the saved connection for that run. With a `repoPath`, the saved connection
 * only applies when the repo is attached to it — unattached checkouts never
 * sync, so connecting does not ingest every registered repo.
 */
export function resolvePortalTarget(options?: {
  repoPath?: string;
}): { target: PortalTargetResolution; source: PortalTargetSource } | null {
  const env = envPortalTarget();
  if (env) return { target: env, source: 'env' };

  const state = readPortalConnectionState();
  if (!state.connection) return null;
  if (options?.repoPath) {
    const canonical = canonicalizeControlRepoPath(options.repoPath);
    if (!state.attachedRepos.includes(canonical)) return null;
  }
  return { target: recordToPortalTarget(state.connection), source: 'connection' };
}

export function resolvePortalTargetForRepo(repoPath?: string): PortalTargetResolution | null {
  return resolvePortalTarget({ repoPath })?.target ?? null;
}

/**
 * True while `target` is still the org this CLI may send to. A target taken
 * from the saved connection goes stale once the user switches org or
 * disconnects; every portal request checks this so an in-flight sync stops
 * instead of sending to the previous org.
 */
export function isPortalTargetActive(target: PortalTargetResolution): boolean {
  if (!target.alias) {
    const env = envPortalTarget();
    return env !== null && env.identityKey === target.identityKey;
  }
  const connection = getActivePortalConnection();
  return connection !== null && recordIdentityKey(connection) === target.identityKey;
}

function trajectoryEnvOverride(): boolean | null {
  const envOverride = process.env.HAR_PORTAL_TRAJECTORY?.trim().toLowerCase();
  if (envOverride === 'on' || envOverride === 'true' || envOverride === '1') return true;
  if (envOverride === 'off' || envOverride === 'false' || envOverride === '0') return false;
  return null;
}

export function isPortalTrajectoryEnabledForTarget(target?: PortalTargetResolution): boolean {
  const override = trajectoryEnvOverride();
  if (override !== null) return override;
  if (!target?.alias) return readTelemetryPreference().portalTrajectory === true;
  const connection = getActivePortalConnection();
  if (!connection || recordIdentityKey(connection) !== target.identityKey) return false;
  return connection.trajectoryForwarding === true;
}

/** Turn trajectory forwarding on/off for the active connection. Throws when disconnected. */
export function writePortalConnectionTrajectoryPreference(enabled: boolean): PortalTargetRecord {
  const state = readPortalConnectionState();
  if (!state.connection) throw new Error('No HAR HQ connection — run har hq connect first.');
  const next: PortalTargetRecord = {
    ...state.connection,
    trajectoryForwarding: enabled,
    updatedAt: new Date().toISOString(),
  };
  writeState({ ...state, connection: next });
  return next;
}

function legacyCredentialsPath(): string {
  if (process.env.HAR_CREDENTIALS_PATH) {
    return path.resolve(process.env.HAR_CREDENTIALS_PATH);
  }
  return path.join(os.homedir(), '.har', 'credentials.json');
}

function syncLegacyCredentialsFile(record: PortalTargetRecord): void {
  const file = legacyCredentialsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        portalUrl: record.portalUrl,
        token: record.token,
        workspace: record.workspaceSlug ?? record.workspaceName,
        email: record.email,
        createdAt: record.createdAt,
        refreshToken: record.refreshToken,
        expiresAt: record.expiresAt,
        workspaceId: record.workspaceId,
        targetAlias: record.alias,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  fs.chmodSync(file, 0o600);
}

function removeLegacyCredentialsFile(): void {
  try {
    fs.unlinkSync(legacyCredentialsPath());
  } catch {
    // missing file is fine
  }
}

/** One-time migration from ~/.har/credentials.json into portal-targets.json. */
export function migrateLegacyCredentialsIfNeeded(): void {
  const targetsFile = portalTargetsPath();
  if (fs.existsSync(targetsFile)) return;

  const legacyFile = legacyCredentialsPath();
  if (!fs.existsSync(legacyFile)) return;

  try {
    const parsed = JSON.parse(fs.readFileSync(legacyFile, 'utf8')) as {
      portalUrl?: string;
      token?: string;
      workspace?: string;
      email?: string;
      refreshToken?: string;
      expiresAt?: string;
      workspaceId?: string;
      targetAlias?: string;
    };
    if (!parsed.portalUrl || !parsed.token) return;

    const workspaceId = resolveWorkspaceId({
      workspaceId: parsed.workspaceId,
      workspace: parsed.workspace,
      alias: parsed.targetAlias,
    });
    const alias =
      parsed.targetAlias && sanitizeAlias(parsed.targetAlias)
        ? sanitizeAlias(parsed.targetAlias)
        : deriveTargetAlias({ portalUrl: parsed.portalUrl, workspace: parsed.workspace });

    const record: PortalTargetRecord = {
      alias,
      portalUrl: normalizePortalUrl(parsed.portalUrl),
      workspaceId,
      workspaceSlug: parsed.workspace,
      workspaceName: parsed.workspace,
      token: parsed.token,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      email: parsed.email,
      trajectoryForwarding: readTelemetryPreference().portalTrajectory === true,
      createdAt: new Date().toISOString(),
    };

    writeState({ connection: record, attachedRepos: listRegisteredRepos() });
  } catch {
    // ignore corrupt legacy files
  }
}
