import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalizeControlRepoPath } from './control-repo-path';
import { readTelemetryPreference } from './telemetry-config';
import { markAllRegisteredDirty } from './sync-context';

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

export interface PortalTargetsStore {
  version: 1;
  /** Global default when a repository has no explicit selection. */
  defaultTarget?: string;
  targets: PortalTargetRecord[];
  /** Canonical repo path → target alias. */
  repoTargets?: Record<string, string>;
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

export type PortalTargetSource =
  | 'env'
  | 'flag'
  | 'repo'
  | 'default'
  | 'explicit';

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

export function normalizePortalUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function portalTargetIdentityKey(portalUrl: string, workspaceId: string): string {
  return `${normalizePortalUrl(portalUrl)}#${workspaceId}`;
}

export function portalTargetsPath(): string {
  if (process.env.HAR_PORTAL_TARGETS_PATH) {
    return path.resolve(process.env.HAR_PORTAL_TARGETS_PATH);
  }
  return path.join(os.homedir(), '.har', 'portal-targets.json');
}

function emptyStore(): PortalTargetsStore {
  return { version: 1, targets: [] };
}

function normalizeStore(raw: Partial<PortalTargetsStore> | null | undefined): PortalTargetsStore {
  const targets = Array.isArray(raw?.targets)
    ? raw!.targets.filter((entry): entry is PortalTargetRecord => {
        return (
          typeof entry?.alias === 'string' &&
          typeof entry?.portalUrl === 'string' &&
          typeof entry?.workspaceId === 'string' &&
          typeof entry?.token === 'string' &&
          typeof entry?.createdAt === 'string'
        );
      })
    : [];
  const repoTargets =
    raw?.repoTargets && typeof raw.repoTargets === 'object'
      ? Object.fromEntries(
          Object.entries(raw.repoTargets).filter(
            (entry): entry is [string, string] =>
              typeof entry[0] === 'string' && typeof entry[1] === 'string',
          ),
        )
      : undefined;
  return {
    version: 1,
    defaultTarget: typeof raw?.defaultTarget === 'string' ? raw.defaultTarget : undefined,
    targets,
    ...(repoTargets && Object.keys(repoTargets).length > 0 ? { repoTargets } : {}),
  };
}

function writeStore(store: PortalTargetsStore): void {
  const file = portalTargetsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(normalizeStore(store), null, 2) + '\n', { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function readPortalTargetsStore(): PortalTargetsStore {
  migrateLegacyCredentialsIfNeeded();
  const file = portalTargetsPath();
  try {
    if (!fs.existsSync(file)) return emptyStore();
    return normalizeStore(JSON.parse(fs.readFileSync(file, 'utf8')) as PortalTargetsStore);
  } catch {
    return emptyStore();
  }
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
  existingAliases: Set<string>;
}): string {
  if (input.alias?.trim()) {
    const candidate = sanitizeAlias(input.alias.trim());
    if (!candidate) throw new Error('Target alias must be alphanumeric (dots, dashes, underscores allowed).');
    if (input.existingAliases.has(candidate)) {
      throw new Error(`Target alias "${candidate}" already exists — pick another name or remove it first.`);
    }
    return candidate;
  }

  const slugBase =
    sanitizeAlias(input.workspaceSlug ?? input.workspace ?? '') ||
    sanitizeAlias(input.workspaceName ?? '') ||
    sanitizeAlias(new URL(input.portalUrl).hostname.replace(/\./g, '-'));

  const candidate = slugBase || 'default';
  if (!input.existingAliases.has(candidate)) return candidate;

  let index = 2;
  while (input.existingAliases.has(`${candidate}-${index}`)) index += 1;
  return `${candidate}-${index}`;
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

export function listPortalTargetRecords(): PortalTargetRecord[] {
  return readPortalTargetsStore().targets;
}

export function getPortalTargetRecord(alias: string): PortalTargetRecord | null {
  const normalized = alias.trim().toLowerCase();
  return readPortalTargetsStore().targets.find((entry) => entry.alias === normalized) ?? null;
}

export function getPortalTargetRecordByIdentity(
  portalUrl: string,
  workspaceId: string,
): PortalTargetRecord | null {
  const key = portalTargetIdentityKey(portalUrl, workspaceId);
  return (
    readPortalTargetsStore().targets.find(
      (entry) => portalTargetIdentityKey(entry.portalUrl, entry.workspaceId) === key,
    ) ?? null
  );
}

export function recordToPortalTarget(record: PortalTargetRecord): PortalTargetResolution {
  return {
    url: normalizePortalUrl(record.portalUrl),
    token: record.token,
    refreshToken: record.refreshToken,
    alias: record.alias,
    workspaceId: record.workspaceId,
    identityKey: portalTargetIdentityKey(record.portalUrl, record.workspaceId),
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

export function upsertPortalTarget(input: {
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
  setAsDefault?: boolean;
}): PortalTargetRecord {
  const store = readPortalTargetsStore();
  const workspaceId = resolveWorkspaceId(input);
  const existingByIdentity = getPortalTargetRecordByIdentity(input.portalUrl, workspaceId);
  const existingAliases = new Set(store.targets.map((entry) => entry.alias));
  if (existingByIdentity) existingAliases.delete(existingByIdentity.alias);

  const alias = existingByIdentity?.alias
    ? existingByIdentity.alias
    : deriveTargetAlias({
        alias: input.alias,
        portalUrl: input.portalUrl,
        workspace: input.workspace,
        workspaceSlug: input.workspaceSlug,
        workspaceName: input.workspaceName,
        existingAliases,
      });

  validateTargetAlias(alias);
  const now = new Date().toISOString();
  const next: PortalTargetRecord = {
    alias,
    portalUrl: normalizePortalUrl(input.portalUrl),
    workspaceId,
    workspaceName: input.workspaceName ?? input.workspace,
    workspaceSlug: input.workspaceSlug ?? input.workspace,
    token: input.token,
    refreshToken: input.refreshToken,
    expiresAt: input.expiresAt,
    email: input.email,
    trajectoryForwarding:
      input.trajectoryForwarding ?? existingByIdentity?.trajectoryForwarding ?? false,
    createdAt: existingByIdentity?.createdAt ?? now,
    updatedAt: now,
    lastUsedAt: now,
  };

  const without = store.targets.filter((entry) => entry.alias !== alias);
  without.push(next);
  const defaultTarget =
    input.setAsDefault || !store.defaultTarget || store.defaultTarget === existingByIdentity?.alias
      ? alias
      : store.defaultTarget;

  writeStore({ ...store, targets: without, defaultTarget });
  syncLegacyCredentialsFile(next, defaultTarget === alias);
  markAllRegisteredDirty();
  return next;
}

export function updatePortalTargetTokens(
  alias: string,
  tokens: { token: string; refreshToken?: string; expiresAt?: string },
): PortalTargetRecord | null {
  const store = readPortalTargetsStore();
  const index = store.targets.findIndex((entry) => entry.alias === alias.trim().toLowerCase());
  if (index < 0) return null;
  const current = store.targets[index];
  const next: PortalTargetRecord = {
    ...current,
    token: tokens.token,
    refreshToken: tokens.refreshToken ?? current.refreshToken,
    expiresAt: tokens.expiresAt ?? current.expiresAt,
    updatedAt: new Date().toISOString(),
  };
  const targets = [...store.targets];
  targets[index] = next;
  writeStore({ ...store, targets });
  if (store.defaultTarget === alias) syncLegacyCredentialsFile(next, true);
  return next;
}

export function removePortalTarget(alias: string): boolean {
  const normalized = alias.trim().toLowerCase();
  const store = readPortalTargetsStore();
  const nextTargets = store.targets.filter((entry) => entry.alias !== normalized);
  if (nextTargets.length === store.targets.length) return false;

  const repoTargets = { ...(store.repoTargets ?? {}) };
  for (const [repoPath, selected] of Object.entries(repoTargets)) {
    if (selected === normalized) delete repoTargets[repoPath];
  }

  let defaultTarget = store.defaultTarget;
  if (defaultTarget === normalized) {
    defaultTarget = nextTargets[0]?.alias;
  }

  writeStore({
    ...store,
    targets: nextTargets,
    defaultTarget,
    ...(Object.keys(repoTargets).length > 0 ? { repoTargets } : {}),
  });

  if (defaultTarget) {
    const fallback = getPortalTargetRecord(defaultTarget);
    if (fallback) syncLegacyCredentialsFile(fallback, true);
  } else {
    removeLegacyCredentialsFile();
  }
  markAllRegisteredDirty();
  return true;
}

export function renamePortalTarget(fromAlias: string, toAlias: string): PortalTargetRecord {
  const from = fromAlias.trim().toLowerCase();
  const to = sanitizeAlias(toAlias);
  if (!to) throw new Error('New target alias is invalid.');
  validateTargetAlias(to);

  const store = readPortalTargetsStore();
  const record = store.targets.find((entry) => entry.alias === from);
  if (!record) throw new Error(`Unknown target "${fromAlias}".`);
  if (store.targets.some((entry) => entry.alias === to)) {
    throw new Error(`Target alias "${to}" already exists.`);
  }

  const targets = store.targets.map((entry) =>
    entry.alias === from ? { ...entry, alias: to, updatedAt: new Date().toISOString() } : entry,
  );
  const repoTargets = Object.fromEntries(
    Object.entries(store.repoTargets ?? {}).map(([repoPath, alias]) => [
      repoPath,
      alias === from ? to : alias,
    ]),
  );
  writeStore({
    ...store,
    targets,
    defaultTarget: store.defaultTarget === from ? to : store.defaultTarget,
    ...(Object.keys(repoTargets).length > 0 ? { repoTargets } : {}),
  });
  return getPortalTargetRecord(to)!;
}

export function setDefaultPortalTarget(alias: string): PortalTargetRecord {
  const record = getPortalTargetRecord(alias);
  if (!record) throw new Error(`Unknown target "${alias}".`);
  const store = readPortalTargetsStore();
  writeStore({ ...store, defaultTarget: record.alias });
  syncLegacyCredentialsFile(record, true);
  return record;
}

export function setRepoPortalTarget(repoPath: string, alias: string): PortalTargetRecord {
  const record = getPortalTargetRecord(alias);
  if (!record) throw new Error(`Unknown target "${alias}".`);
  const canonical = canonicalizeControlRepoPath(repoPath);
  const store = readPortalTargetsStore();
  writeStore({
    ...store,
    repoTargets: { ...(store.repoTargets ?? {}), [canonical]: record.alias },
  });
  return record;
}

export function clearRepoPortalTarget(repoPath: string): boolean {
  const canonical = canonicalizeControlRepoPath(repoPath);
  const store = readPortalTargetsStore();
  if (!store.repoTargets?.[canonical]) return false;
  const repoTargets = { ...store.repoTargets };
  delete repoTargets[canonical];
  writeStore({
    ...store,
    ...(Object.keys(repoTargets).length > 0 ? { repoTargets } : {}),
  });
  return true;
}

export function getRepoPortalTargetAlias(repoPath: string): string | null {
  const canonical = canonicalizeControlRepoPath(repoPath);
  return readPortalTargetsStore().repoTargets?.[canonical] ?? null;
}

export function resolvePortalTargetsForRepo(options?: {
  repoPath?: string;
  explicitTargets?: string[];
}): { targets: PortalTargetResolution[]; source: PortalTargetSource } | null {
  if (process.env.HAR_PORTAL_URL && process.env.HAR_PORTAL_TOKEN) {
    const url = normalizePortalUrl(process.env.HAR_PORTAL_URL);
    return {
      source: 'env',
      targets: [
        {
          url,
          token: process.env.HAR_PORTAL_TOKEN,
          identityKey: url,
        },
      ],
    };
  }

  if (options?.explicitTargets && options.explicitTargets.length > 0) {
    const targets = options.explicitTargets.map((alias) => {
      const record = getPortalTargetRecord(alias);
      if (!record) throw new Error(`Unknown portal target "${alias}".`);
      return recordToPortalTarget(record);
    });
    return { source: 'explicit', targets };
  }

  const store = readPortalTargetsStore();
  if (options?.repoPath) {
    const alias = getRepoPortalTargetAlias(options.repoPath);
    if (alias) {
      const record = getPortalTargetRecord(alias);
      if (record) return { source: 'repo', targets: [recordToPortalTarget(record)] };
    }
  }

  if (store.defaultTarget) {
    const record = getPortalTargetRecord(store.defaultTarget);
    if (record) return { source: 'default', targets: [recordToPortalTarget(record)] };
  }

  if (store.targets.length === 1) {
    return { source: 'default', targets: [recordToPortalTarget(store.targets[0])] };
  }

  return null;
}

export function resolvePortalTargetForRepo(repoPath?: string): PortalTargetResolution | null {
  return resolvePortalTargetsForRepo({ repoPath })?.targets[0] ?? null;
}

export function resolvePortalTargetAliases(explicit?: string): string[] {
  if (!explicit?.trim()) return [];
  return explicit
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

export function isPortalTrajectoryEnabledForTarget(target?: PortalTargetResolution): boolean {
  if (!target?.alias) {
    const envOverride = process.env.HAR_PORTAL_TRAJECTORY?.trim().toLowerCase();
    if (envOverride === 'on' || envOverride === 'true' || envOverride === '1') return true;
    if (envOverride === 'off' || envOverride === 'false' || envOverride === '0') return false;
    return readTelemetryPreference().portalTrajectory === true;
  }
  const envOverride = process.env.HAR_PORTAL_TRAJECTORY?.trim().toLowerCase();
  if (envOverride === 'on' || envOverride === 'true' || envOverride === '1') return true;
  if (envOverride === 'off' || envOverride === 'false' || envOverride === '0') return false;
  const record = getPortalTargetRecord(target.alias);
  return record?.trajectoryForwarding === true;
}

export function writePortalTargetTrajectoryPreference(
  alias: string,
  enabled: boolean,
): PortalTargetRecord {
  const store = readPortalTargetsStore();
  const index = store.targets.findIndex((entry) => entry.alias === alias.trim().toLowerCase());
  if (index < 0) throw new Error(`Unknown target "${alias}".`);
  const targets = [...store.targets];
  targets[index] = {
    ...targets[index],
    trajectoryForwarding: enabled,
    updatedAt: new Date().toISOString(),
  };
  writeStore({ ...store, targets });
  return targets[index];
}

function legacyCredentialsPath(): string {
  if (process.env.HAR_CREDENTIALS_PATH) {
    return path.resolve(process.env.HAR_CREDENTIALS_PATH);
  }
  return path.join(os.homedir(), '.har', 'credentials.json');
}

function syncLegacyCredentialsFile(record: PortalTargetRecord, isDefault: boolean): void {
  if (!isDefault) return;
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
        : deriveTargetAlias({
            portalUrl: parsed.portalUrl,
            workspace: parsed.workspace,
            existingAliases: new Set(),
          });

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

    writeStore({ version: 1, defaultTarget: alias, targets: [record] });
  } catch {
    // ignore corrupt legacy files
  }
}
