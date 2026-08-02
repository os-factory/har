jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
}));
jest.mock('../src/harness/manifest', () => ({
  readManifest: () => ({ profile: 'cli' }),
  resolveHarnessRoot: (p: string) => p,
}));
jest.mock('../src/harness/stages', () => ({ readStageRegistry: () => null }));

import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { ensureRepoRegisteredWithControl } from '../src/core/control-sync';
import { listRegisteredRepos } from '../src/core/control-registry';

const realFetch = global.fetch;

describe('ensureRepoRegisteredWithControl', () => {
  let registryPath: string;
  let repoPath: string;

  beforeEach(() => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-registry-'));
    registryPath = path.join(tmpDir, 'repos.json');
    repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-registry-repo-'));
    process.env.HAR_CONTROL_REGISTRY_PATH = registryPath;
  });

  afterEach(() => {
    delete process.env.HAR_CONTROL_REGISTRY_PATH;
    (global as unknown as { fetch: unknown }).fetch = realFetch;
    fs.rmSync(repoPath, { recursive: true, force: true });
  });

  it('records the repo locally and registers it with Mission Control', async () => {
    const posted: unknown[] = [];
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/repos') && init?.method === 'POST') {
        posted.push(JSON.parse(String(init.body)));
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          text: async () => '',
          json: async () => ({ id: 'repo-1' }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    await ensureRepoRegisteredWithControl(repoPath, 'http://127.0.0.1:3847');

    expect(listRegisteredRepos()).toEqual([repoPath]);
    expect(posted).toEqual([expect.objectContaining({ path: repoPath })]);
  });

  it('does not throw when Mission Control registration fails', async () => {
    (global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
      json: async () => ({}),
    }));

    await expect(
      ensureRepoRegisteredWithControl(repoPath, 'http://127.0.0.1:3847'),
    ).resolves.toBeUndefined();

    // Local registry write still happens even when the API call fails.
    expect(listRegisteredRepos()).toEqual([repoPath]);
  });
});
