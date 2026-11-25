const KERNO_API_BY_PORTAL_HOST: Readonly<Record<string, string>> = {
  'portal.kerno.io': 'https://api.kerno.io',
  'app.harhq.com': 'https://api.kerno.io',
  'portal.dev.kerno.io': 'https://api.dev.kerno.io',
  'app.dev.harhq.com': 'https://api.dev.kerno.io',
  // HAR_PORTAL_URL is often set to the API itself in CI; without these it would post to /api/sync there.
  'api.kerno.io': 'https://api.kerno.io',
  'api.dev.kerno.io': 'https://api.dev.kerno.io',
};

/** Where Kerno's portal-api serves the har ingest routes. */
export const KERNO_INGEST_PREFIX = '/api/har/ingest';

/**
 * A Kerno portal API key, created on the portal's API key page. Unlike a
 * `har_ingest_` token from `har hq connect`, it has no refresh token: when it
 * is rejected, only a new key helps.
 */
export function isPortalApiKey(token: string): boolean {
  return token.startsWith('sk-bf-');
}

export function kernoApiUrlFor(portalUrl: string): string | undefined {
  const override = process.env.HAR_API_URL?.trim().replace(/\/+$/, '');
  if (override) return override;
  try {
    return KERNO_API_BY_PORTAL_HOST[new URL(portalUrl).hostname];
  } catch {
    return undefined;
  }
}
