import { readPortalCredentials } from './portal-credentials';

/** Default Mission Control API base URL (local Docker Compose). */
export const DEFAULT_CONTROL_API_URL = 'http://localhost:3847';

export const DEFAULT_PORTAL_URL = 'https://app.harhq.com';

export function getControlApiUrl(): string {
  return process.env.HAR_CONTROL_API_URL ?? DEFAULT_CONTROL_API_URL;
}

export function isControlEnabled(): boolean {
  return process.env.HAR_CONTROL_DISABLED !== 'true';
}

export interface PortalTarget {
  url: string;
  token: string;
  refreshToken?: string;
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

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
    const url = normalizeUrl((value ?? '').trim());
    if (url) return { url, source };
  }

  return { url: DEFAULT_PORTAL_URL, source: 'default' };
}

export function getPortalTarget(): PortalTarget | null {
  if (process.env.HAR_PORTAL_URL && process.env.HAR_PORTAL_TOKEN) {
    return {
      url: normalizeUrl(process.env.HAR_PORTAL_URL),
      token: process.env.HAR_PORTAL_TOKEN,
    };
  }

  const stored = readPortalCredentials();
  if (stored) {
    return {
      url: normalizeUrl(stored.portalUrl),
      token: stored.token,
      refreshToken: stored.refreshToken,
    };
  }

  if (process.env.HAR_CLOUD_API_URL && process.env.HAR_CLOUD_API_KEY) {
    return {
      url: normalizeUrl(process.env.HAR_CLOUD_API_URL),
      token: process.env.HAR_CLOUD_API_KEY,
    };
  }

  return null;
}
