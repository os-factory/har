import { kernoApiUrlFor } from '../src/core/portal-hosts';

describe('kernoApiUrlFor', () => {
  afterEach(() => {
    delete process.env.HAR_API_URL;
  });

  it("maps Kerno's har portals, old and new, to their portal-api", () => {
    expect(kernoApiUrlFor('https://portal.kerno.io/har')).toBe('https://api.kerno.io');
    expect(kernoApiUrlFor('https://app.harhq.com')).toBe('https://api.kerno.io');
    expect(kernoApiUrlFor('https://portal.dev.kerno.io/har/')).toBe('https://api.dev.kerno.io');
    expect(kernoApiUrlFor('https://app.dev.harhq.com')).toBe('https://api.dev.kerno.io');
  });

  it('has no portal-api for other portals', () => {
    expect(kernoApiUrlFor('https://har.example.com')).toBeUndefined();
    expect(kernoApiUrlFor('http://localhost:3020/har')).toBeUndefined();
  });

  it('uses HAR_API_URL for any portal when it is set', () => {
    process.env.HAR_API_URL = 'http://localhost:4020/';
    expect(kernoApiUrlFor('http://localhost:3020/har')).toBe('http://localhost:4020');
  });
});
