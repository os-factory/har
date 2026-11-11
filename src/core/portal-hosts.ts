interface KernoDeployment {
  portalUrl: string;
  apiUrl: string;
  legacyHost: string;
  portalHost: string;
}

const PORTAL_BASE_PATH = '/har';

const KERNO_DEPLOYMENTS: readonly KernoDeployment[] = [
  {
    portalUrl: 'https://portal.kerno.io/har',
    apiUrl: 'https://api.kerno.io',
    legacyHost: 'app.harhq.com',
    portalHost: 'portal.kerno.io',
  },
  {
    portalUrl: 'https://portal.dev.kerno.io/har',
    apiUrl: 'https://api.dev.kerno.io',
    legacyHost: 'app.dev.harhq.com',
    portalHost: 'portal.dev.kerno.io',
  },
];

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function isUnderPortalBase(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '');
  return path === PORTAL_BASE_PATH || path.startsWith(`${PORTAL_BASE_PATH}/`);
}

function legacyDeployment(url: string): KernoDeployment | undefined {
  const parsed = parse(url);
  return parsed
    ? KERNO_DEPLOYMENTS.find((entry) => entry.legacyHost === parsed.hostname)
    : undefined;
}

function kernoDeployment(url: string): KernoDeployment | undefined {
  const parsed = parse(url);
  if (!parsed) return undefined;
  return KERNO_DEPLOYMENTS.find(
    (entry) =>
      entry.legacyHost === parsed.hostname ||
      (entry.portalHost === parsed.hostname && isUnderPortalBase(parsed.pathname)),
  );
}

export function isLegacyPortalUrl(url: string): boolean {
  return legacyDeployment(url) !== undefined;
}

export function migrateLegacyPortalUrl(url: string): string {
  const deployment = legacyDeployment(url);
  if (!deployment) return url;
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, '');
  const pathBelowPortalBase = isUnderPortalBase(path) ? path.slice(PORTAL_BASE_PATH.length) : path;
  return `${deployment.portalUrl}${pathBelowPortalBase}${parsed.search}`;
}

export function kernoApiUrlFor(portalUrl: string): string | undefined {
  return kernoDeployment(portalUrl)?.apiUrl;
}

const settingsWarnedAboutLegacyHost = new Set<string>();

export function migrateConfiguredPortalUrl(url: string, setting: string): string {
  if (!isLegacyPortalUrl(url)) return url;
  const migrated = migrateLegacyPortalUrl(url);
  if (!settingsWarnedAboutLegacyHost.has(setting)) {
    settingsWarnedAboutLegacyHost.add(setting);
    process.stderr.write(
      `[har] ${new URL(url).host} has moved to ${migrated}; using that instead. Update ${setting}.\n`,
    );
  }
  return migrated;
}
