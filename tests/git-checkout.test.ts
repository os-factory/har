import { execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { gitCommonDir, sameGitCheckout } from '../src/utils/git-checkout';
import { pm2DaemonRunning } from '../src/utils/pm2';

function git(cwd: string, args: string): string {
  return execSync(`git ${args}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
}

function gitReportedCommonDir(cwd: string): string {
  return fs.realpathSync(path.resolve(cwd, git(cwd, 'rev-parse --git-common-dir')));
}

describe('gitCommonDir (filesystem resolution)', () => {
  let tmp: string;
  let main: string;
  let linked: string;
  let other: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-git-checkout-'));
    main = path.join(tmp, 'main');
    linked = path.join(tmp, 'linked');
    other = path.join(tmp, 'other');
    for (const dir of [main, other]) {
      fs.mkdirSync(dir);
      git(dir, 'init -q');
      git(dir, '-c user.email=t@t -c user.name=t commit -q --allow-empty -m init');
    }
    fs.mkdirSync(path.join(main, 'pkg', 'nested'), { recursive: true });
    git(main, `worktree add -q -b side ${JSON.stringify(linked)}`);
    fs.mkdirSync(path.join(linked, 'pkg'), { recursive: true });
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it.each([
    ['main checkout', () => main],
    ['main checkout subdir', () => path.join(main, 'pkg', 'nested')],
    ['linked worktree', () => linked],
    ['linked worktree subdir', () => path.join(linked, 'pkg')],
  ])('matches git rev-parse for a %s', (_label, dir) => {
    expect(gitCommonDir(dir())).toBe(gitReportedCommonDir(dir()));
  });

  it('treats a linked worktree and its main checkout as the same checkout', () => {
    expect(sameGitCheckout(path.join(main, 'pkg'), linked)).toBe(true);
  });

  it('separates unrelated repositories', () => {
    expect(sameGitCheckout(main, other)).toBe(false);
  });

  it('returns undefined outside any repository', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'har-no-git-'));
    try {
      if (gitCommonDirOutsideRepoIsUndefined(plain)) {
        expect(gitCommonDir(plain)).toBeUndefined();
        expect(sameGitCheckout(plain, main)).toBe(false);
      }
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

/** Skip the outside-repo case when the OS temp dir itself sits inside a checkout. */
function gitCommonDirOutsideRepoIsUndefined(dir: string): boolean {
  try {
    git(dir, 'rev-parse --git-common-dir');
    return false;
  } catch {
    return true;
  }
}

describe('pm2DaemonRunning', () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'har-pm2-home-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('is false without a pid file', () => {
    expect(pm2DaemonRunning({ PM2_HOME: home })).toBe(false);
  });

  it('is true when the pid file names a live process', () => {
    fs.writeFileSync(path.join(home, 'pm2.pid'), String(process.pid));
    expect(pm2DaemonRunning({ PM2_HOME: home })).toBe(true);
  });

  it('is false when the pid file names an exited process', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    const pid = child.pid!;
    await new Promise((resolve) => child.on('exit', resolve));
    fs.writeFileSync(path.join(home, 'pm2.pid'), String(pid));
    expect(pm2DaemonRunning({ PM2_HOME: home })).toBe(false);
  });

  it('is false for a garbage pid file', () => {
    fs.writeFileSync(path.join(home, 'pm2.pid'), 'not-a-pid');
    expect(pm2DaemonRunning({ PM2_HOME: home })).toBe(false);
  });
});
