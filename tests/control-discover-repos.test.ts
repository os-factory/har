jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
  resolveMainWorkingTree: (p: string) => p,
}));
jest.mock('../src/harness/manifest', () => ({
  readManifest: () => ({ version: '1' }),
  resolveHarnessRoot: (p: string) => p,
}));
jest.mock('../src/core/control-registry', () => ({
  listRegisteredRepos: jest.fn(() => ['/repos/a', '/repos/b']),
  recordRepoForControlSync: jest.fn(),
  removeRegisteredRepo: jest.fn(),
}));

import { discoverHarRepos } from '../src/core/control-sync';

const realFetch = global.fetch;

describe('discoverHarRepos', () => {
  beforeEach(() => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn();
  });
  afterEach(() => {
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('returns the registry entries without any network call', async () => {
    const repos = await discoverHarRepos();
    expect(repos).toEqual(['/repos/a', '/repos/b']);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('adds the optional cwd when it has a manifest, still without a network call', async () => {
    const repos = await discoverHarRepos({ cwd: '/repos/c' });
    expect(repos).toEqual(['/repos/a', '/repos/b', '/repos/c']);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
