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
}

export function getPortalTarget(): PortalTarget | null {
  const url = process.env.HAR_PORTAL_URL ?? process.env.HAR_CLOUD_API_URL;
  const token = process.env.HAR_PORTAL_TOKEN ?? process.env.HAR_CLOUD_API_KEY;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}
