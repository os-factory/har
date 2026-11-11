import {
  isLegacyPortalUrl,
  kernoApiUrlFor,
  migrateConfiguredPortalUrl,
  migrateLegacyPortalUrl,
} from '../src/core/portal-hosts';

describe('portal hosts', () => {
  it('moves the old harhq hosts to the Kerno portal', () => {
    expect(migrateLegacyPortalUrl('https://app.harhq.com')).toBe('https://portal.kerno.io/har');
    expect(migrateLegacyPortalUrl('https://app.dev.harhq.com/')).toBe(
      'https://portal.dev.kerno.io/har',
    );
    expect(migrateLegacyPortalUrl('https://app.harhq.com/har')).toBe('https://portal.kerno.io/har');
  });

  it('leaves other hosts alone', () => {
    expect(isLegacyPortalUrl('https://portal.kerno.io/har')).toBe(false);
    expect(migrateLegacyPortalUrl('http://localhost:3020/har')).toBe('http://localhost:3020/har');
  });

  it("maps Kerno's har portals to their portal-api", () => {
    expect(kernoApiUrlFor('https://app.harhq.com')).toBe('https://api.kerno.io');
    expect(kernoApiUrlFor('https://portal.kerno.io/har')).toBe('https://api.kerno.io');
    expect(kernoApiUrlFor('https://portal.dev.kerno.io/har/')).toBe('https://api.dev.kerno.io');
    expect(kernoApiUrlFor('https://app.dev.harhq.com')).toBe('https://api.dev.kerno.io');
  });

  it('uses HAR_API_URL for any portal when it is set', () => {
    process.env.HAR_API_URL = 'http://localhost:4020/';
    try {
      expect(kernoApiUrlFor('http://localhost:3020/har')).toBe('http://localhost:4020');
    } finally {
      delete process.env.HAR_API_URL;
    }
  });

  it('has no portal-api for self-hosted portals or the portal outside /har', () => {
    expect(kernoApiUrlFor('https://har.example.com')).toBeUndefined();
    expect(kernoApiUrlFor('https://portal.kerno.io')).toBeUndefined();
    expect(kernoApiUrlFor('http://localhost:3020/har')).toBeUndefined();
  });

  it('warns once per setting when a configured URL is on an old host', () => {
    const write = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(migrateConfiguredPortalUrl('https://app.harhq.com', 'HAR_TEST_URL')).toBe(
        'https://portal.kerno.io/har',
      );
      migrateConfiguredPortalUrl('https://app.harhq.com', 'HAR_TEST_URL');
      expect(write).toHaveBeenCalledTimes(1);
      expect(String(write.mock.calls[0][0])).toContain('Update HAR_TEST_URL');
    } finally {
      write.mockRestore();
    }
  });
});
