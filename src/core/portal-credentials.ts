import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getPortalTargetRecord,
  migrateLegacyCredentialsIfNeeded,
  readPortalTargetsStore,
  resolveWorkspaceId,
  upsertPortalTarget,
} from './portal-targets';
import { markAllRegisteredDirty } from './sync-context';

export interface PortalCredentials {
  portalUrl: string;
  token: string;
  workspace?: string;
  workspaceSlug?: string;
  workspaceName?: string;
  workspaceId?: string;
  targetAlias?: string;
  email?: string;
  createdAt: string;
  refreshToken?: string;
  expiresAt?: string;
}

export function portalCredentialsPath(): string {
  if (process.env.HAR_CREDENTIALS_PATH) {
    return path.resolve(process.env.HAR_CREDENTIALS_PATH);
  }
  return path.join(os.homedir(), '.har', 'credentials.json');
}

export function readPortalCredentials(): PortalCredentials | null {
  migrateLegacyCredentialsIfNeeded();
  const store = readPortalTargetsStore();
  const alias = store.defaultTarget ?? store.targets[0]?.alias;
  if (alias) {
    const record = getPortalTargetRecord(alias);
    if (record) {
      return {
        portalUrl: record.portalUrl,
        token: record.token,
        workspace: record.workspaceSlug ?? record.workspaceName,
        workspaceId: record.workspaceId,
        targetAlias: record.alias,
        email: record.email,
        createdAt: record.createdAt,
        refreshToken: record.refreshToken,
        expiresAt: record.expiresAt,
      };
    }
  }

  try {
    const raw = fs.readFileSync(portalCredentialsPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PortalCredentials>;
    if (!parsed.portalUrl || !parsed.token) return null;
    return {
      portalUrl: parsed.portalUrl,
      token: parsed.token,
      workspace: parsed.workspace,
      workspaceId: parsed.workspaceId,
      targetAlias: parsed.targetAlias,
      email: parsed.email,
      createdAt: parsed.createdAt ?? '',
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
    };
  } catch {
    return null;
  }
}

/** @deprecated Prefer upsertPortalTarget — kept for callers not yet on named targets. */
export function writePortalCredentials(creds: PortalCredentials): void {
  upsertPortalTarget({
    alias: creds.targetAlias,
    portalUrl: creds.portalUrl,
    workspaceId: creds.workspaceId,
    workspace: creds.workspace,
    token: creds.token,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
    email: creds.email,
    setAsDefault: true,
  });
  markAllRegisteredDirty();
}

export function legacyWorkspaceIdFromCredentials(creds: PortalCredentials): string {
  return resolveWorkspaceId({
    workspaceId: creds.workspaceId,
    workspace: creds.workspace,
    alias: creds.targetAlias,
  });
}
