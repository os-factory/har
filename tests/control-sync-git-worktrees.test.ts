import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { listLinkedWorktreeDetails } from '../src/core/control-repo-path';
import { syncGitWorktreesWithControl } from '../src/core/control-sync';

/**
 * Mission Control in docker cannot read `<repo>/.git/worktrees` (FE-2058): the
 * CLI, on the host, reports each repository's linked worktrees when it syncs.
 */

function sh(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'har-wt-report-'));
  sh(dir, 'git init -q -b main');
  sh(dir, 'git -c user.email=har@test.local -c user.name=har commit -q --allow-empty -m init');
  return dir;
}

describe('listLinkedWorktreeDetails', () => {
  it('lists linked worktrees with branch and HEAD, without the main checkout', () => {
    const main = initRepo();
    const feature = path.join(`${main}-feat`);
    const detached = path.join(`${main}-detached`);
    sh(main, `git worktree add -q -b feat "${feature}"`);
    sh(main, `git worktree add -q --detach "${detached}"`);
    const head = sh(main, 'git rev-parse HEAD');

    const listed = listLinkedWorktreeDetails(main);

    expect(listed).toHaveLength(2);
    expect(listed).toEqual(
      expect.arrayContaining([
        { path: path.resolve(feature), branch: 'feat', head },
        { path: path.resolve(detached), branch: null, head },
      ]),
    );
    expect(listLinkedWorktreeDetails(feature)).toEqual(listed);
  });

  it('returns nothing outside a git repository', () => {
    expect(listLinkedWorktreeDetails(fs.mkdtempSync(path.join(os.tmpdir(), 'har-no-git-')))).toEqual([]);
  });
});

describe('syncGitWorktreesWithControl', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    (global as unknown as { fetch: unknown }).fetch = realFetch;
  });

  it('posts the host listing to the repository\'s git-worktrees route', async () => {
    const main = initRepo();
    const feature = `${main}-feat`;
    sh(main, `git worktree add -q -b feat "${feature}"`);
    const fetchMock = jest.fn(async () => new Response('{}', { status: 200 }));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;

    await syncGitWorktreesWithControl('http://mc.test', 'repo-1', main);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toBe('http://mc.test/api/repos/repo-1/git-worktrees');
    expect(JSON.parse(init.body)).toEqual({
      worktrees: [{ path: path.resolve(feature), branch: 'feat', head: expect.stringMatching(/^[0-9a-f]{40}$/) }],
      generatedAt: expect.any(String),
    });
  });

  it('never fails the sync when Mission Control predates the route', async () => {
    const fetchMock = jest.fn(async () => new Response('', { status: 404 }));
    (global as unknown as { fetch: unknown }).fetch = fetchMock;
    await expect(syncGitWorktreesWithControl('http://mc.test', 'repo-1', initRepo())).resolves.toBeUndefined();
  });
});
