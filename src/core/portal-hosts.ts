const KERNO_API_BY_PORTAL_HOST: Readonly<Record<string, string>> = {
  'portal.kerno.io': 'https://api.kerno.io',
  'app.harhq.com': 'https://api.kerno.io',
  'portal.dev.kerno.io': 'https://api.dev.kerno.io',
  'app.dev.harhq.com': 'https://api.dev.kerno.io',
};

export function kernoApiUrlFor(portalUrl: string): string | undefined {
  const override = process.env.HAR_API_URL?.trim().replace(/\/+$/, '');
  if (override) return override;
  try {
    return KERNO_API_BY_PORTAL_HOST[new URL(portalUrl).hostname];
  } catch {
    return undefined;
  }
}
