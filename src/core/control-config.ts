import { readPortalCredentials } from './portal-credentials';
import {
  normalizePortalUrl,
  readPortalTargetsStore,
  recordToPortalTarget,
  resolvePortalTargetForRepo,
  type PortalTargetResolution,
} from './portal-targets';

/** Default Mission Control API base URL (local Docker Compose). */
export const DEFAULT_CONTROL_API_URL = 'http://localhost:3847';

export const DEFAULT_PORTAL_URL = 'https://app.harhq.com';

export function getControlApiUrl(): string {
  return process.env.HAR_CONTROL_API_URL ?? DEFAULT_CONTROL_API_URL;
}

export function isControlEnabled(): boolean {
  return process.env.HAR_CONTROL_DISABLED !== 'true';
}

export type PortalTarget = PortalTargetResolution;

export type PortalUrlSource = 'flag' | 'env' | 'saved' | 'default';

export function resolvePortalUrl(explicit?: string): {
  url: string;
  source: PortalUrlSource;
} {
  const candidates: Array<[string | undefined, PortalUrlSource]> = [
    [explicit, 'flag'],
    [process.env.HAR_PORTAL_URL, 'env'],
    [readPortalCredentials()?.portalUrl, 'saved'],
  ];

  for (const [value, source] of candidates) {
    const url = normalizePortalUrl((value ?? '').trim());
    if (url) return { url, source };
  }

  return { url: DEFAULT_PORTAL_URL, source: 'default' };
}

export function getPortalTarget(repoPath?: string): PortalTarget | null {
  const resolved = resolvePortalTargetForRepo(repoPath);
  if (resolved) return resolved;

  if (process.env.HAR_CLOUD_API_URL && process.env.HAR_CLOUD_API_KEY) {
    const url = normalizePortalUrl(process.env.HAR_CLOUD_API_URL);
    return {
      url,
      token: process.env.HAR_CLOUD_API_KEY,
      identityKey: url,
    };
  }

  return null;
}

export function describePortalTarget(target: PortalTarget): string {
  const alias = target.alias ? `${target.alias} ` : '';
  const workspace = target.workspaceId ? ` (${target.workspaceId})` : '';
  return `${alias}@ ${target.url}${workspace}`.trim();
}

export function listSavedPortalUrls(): string[] {
  const store = readPortalTargetsStore();
  return [...new Set(store.targets.map((entry) => normalizePortalUrl(entry.portalUrl)))];
}

export function getDefaultPortalTargetRecord() {
  const store = readPortalTargetsStore();
  const alias = store.defaultTarget ?? store.targets[0]?.alias;
  if (!alias) return null;
  const record = store.targets.find((entry) => entry.alias === alias);
  return record ? recordToPortalTarget(record) : null;
}
