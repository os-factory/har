jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
  resolveMainWorkingTree: (p: string) => p,
}));
jest.mock('../src/harness/manifest', () => ({
  readManifest: () => ({ profile: 'cli' }),
  resolveHarnessRoot: (p: string) => p,
}));
jest.mock('../src/harness/stages', () => ({ readStageRegistry: () => null }));

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listRegisteredRepos,
  recordRepoForControlSync,
  removeRegisteredRepo,
} from '../src/core/control-registry';
import { registerRepoWithControl } from '../src/core/control-sync';

const realFetch = global.fetch;
const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

describe('registerRepoWithControl unregistered tombstone', () => {
  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-unreg-registry-'));
    process.env.HAR_CONTROL_REGISTRY_PATH = path.join(tmpDir, 'repos.json');
    recordRepoForControlSync(FIXTURE);
  });

  afterEach(() => {
    delete process.env.HAR_CONTROL_REGISTRY_PATH;
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('drops path from local registry on 409 and returns null', async () => {
    expect(listRegisteredRepos().length).toBeGreaterThan(0);

    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      text: async () =>
        JSON.stringify({
          error: 'Repository was unregistered',
          path: FIXTURE,
        }),
      json: async () => ({ error: 'Repository was unregistered', path: FIXTURE }),
    }));

    const result = await registerRepoWithControl({
      repoPath: FIXTURE,
      apiUrl: 'http://127.0.0.1:3847',
    });

    expect(result).toBeNull();
    expect(listRegisteredRepos()).toEqual([]);
  });

  it('does not remove registry entry on successful register', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => '',
      json: async () => ({ id: 'repo-1' }),
    }));

    const result = await registerRepoWithControl({
      repoPath: FIXTURE,
      apiUrl: 'http://127.0.0.1:3847',
    });

    expect(result).toEqual({ id: 'repo-1' });
    expect(listRegisteredRepos().length).toBeGreaterThan(0);
  });

  it('throws on non-409 API errors without clearing registry', async () => {
    recordRepoForControlSync(FIXTURE);
    const before = listRegisteredRepos();

    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
      json: async () => ({}),
    }));

    await expect(
      registerRepoWithControl({ repoPath: FIXTURE, apiUrl: 'http://127.0.0.1:3847' }),
    ).rejects.toThrow(/Control API 500/);

    expect(listRegisteredRepos()).toEqual(before);
    expect(removeRegisteredRepo(FIXTURE)).toBe(true);
  });
});
