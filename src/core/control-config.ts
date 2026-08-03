import { readPortalCredentials } from './portal-credentials';

/** Default Mission Control API base URL (local Docker Compose). */
export const DEFAULT_CONTROL_API_URL = 'http://localhost:3847';

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
