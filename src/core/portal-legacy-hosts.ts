import { renamePortalWatermarkKeys } from './portal-watermark';

const PORTAL_BASE_PATH = '/har';

const PORTAL_BASE_BY_LEGACY_HOST: ReadonlyMap<string, string> = new Map([
  ['app.harhq.com', 'https://portal.kerno.io/har'],
  ['app.dev.harhq.com', 'https://portal.dev.kerno.io/har'],
]);

const LEGACY_PORTAL_URL_IN_KEY =
  /https?:\/\/(?:app\.harhq\.com|app\.dev\.harhq\.com)(?=[#/]|$)[^#]*/gi;

function legacyPortalBase(url: string): string | undefined {
  try {
    return PORTAL_BASE_BY_LEGACY_HOST.get(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

export function isLegacyPortalUrl(url: string): boolean {
  return legacyPortalBase(url) !== undefined;
}

export function migrateLegacyPortalUrl(url: string): string {
  const portalBase = legacyPortalBase(url);
  if (!portalBase) return url;
  const parsed = new URL(url);
  const path = parsed.pathname.replace(/\/+$/, '');
  const isUnderPortalBase = path === PORTAL_BASE_PATH || path.startsWith(`${PORTAL_BASE_PATH}/`);
  const pathBelowPortalBase = isUnderPortalBase ? path.slice(PORTAL_BASE_PATH.length) : path;
  return `${portalBase}${pathBelowPortalBase}${parsed.search}`;
}

export function migrateLegacyPortalKey(key: string): string {
  return key.replace(LEGACY_PORTAL_URL_IN_KEY, (url) => migrateLegacyPortalUrl(url));
}

const settingsWarnedAboutLegacyHost = new Set<string>();

export function migrateConfiguredPortalUrl(url: string, setting: string): string {
  if (!isLegacyPortalUrl(url)) return url;
  const migrated = migrateLegacyPortalUrl(url);
  if (!settingsWarnedAboutLegacyHost.has(setting)) {
    settingsWarnedAboutLegacyHost.add(setting);
    renamePortalWatermarkKeys(migrateLegacyPortalKey);
    process.stderr.write(
      `[har] ${new URL(url).host} has moved to ${migrated}; using that instead. Update ${setting}.\n`,
    );
  }
  return migrated;
}
