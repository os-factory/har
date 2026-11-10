import {
  isLegacyPortalUrl,
  migrateLegacyPortalKey,
  migrateLegacyPortalUrl,
} from '../src/core/portal-legacy-hosts';

describe('migrateLegacyPortalUrl', () => {
  it.each([
    ['https://app.harhq.com', 'https://portal.kerno.io/har'],
    ['https://app.harhq.com/', 'https://portal.kerno.io/har'],
    ['https://app.harhq.com/har', 'https://portal.kerno.io/har'],
    ['https://app.harhq.com/har/', 'https://portal.kerno.io/har'],
    ['https://app.harhq.com/api/sync?x=1', 'https://portal.kerno.io/har/api/sync?x=1'],
    ['https://app.harhq.com/har/api/sync', 'https://portal.kerno.io/har/api/sync'],
    ['https://APP.HARHQ.COM', 'https://portal.kerno.io/har'],
    ['http://app.harhq.com', 'https://portal.kerno.io/har'],
    ['https://app.dev.harhq.com', 'https://portal.dev.kerno.io/har'],
    ['https://app.dev.harhq.com/har', 'https://portal.dev.kerno.io/har'],
  ])('moves %s to %s', (legacy, portal) => {
    expect(migrateLegacyPortalUrl(legacy)).toBe(portal);
  });

  it('does not treat /harbour as the portal base path', () => {
    expect(migrateLegacyPortalUrl('https://app.harhq.com/harbour')).toBe(
      'https://portal.kerno.io/har/harbour',
    );
  });

  it.each([
    'https://portal.kerno.io/har',
    'https://app.harhq.com.example.com',
    'https://harhq.com',
    'http://localhost:3847',
    'not a url',
    '',
  ])('leaves %p alone', (url) => {
    expect(migrateLegacyPortalUrl(url)).toBe(url);
    expect(isLegacyPortalUrl(url)).toBe(false);
  });
});

describe('migrateLegacyPortalKey', () => {
  it.each([
    ['https://app.harhq.com#ws_1', 'https://portal.kerno.io/har#ws_1'],
    ['runs:https://app.harhq.com#ws_1', 'runs:https://portal.kerno.io/har#ws_1'],
    ['spans:https://app.dev.harhq.com', 'spans:https://portal.dev.kerno.io/har'],
    ['trajectory:https://app.harhq.com/har#ws_1', 'trajectory:https://portal.kerno.io/har#ws_1'],
  ])('moves %s to %s', (legacy, portal) => {
    expect(migrateLegacyPortalKey(legacy)).toBe(portal);
  });

  it.each(['runs:https://portal.kerno.io/har#ws_1', 'runs:https://app.harhq.com.example.com#ws_1'])(
    'leaves %s alone',
    (key) => {
      expect(migrateLegacyPortalKey(key)).toBe(key);
    },
  );
});
