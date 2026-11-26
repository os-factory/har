import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import {
  FileLockTimeoutError,
  acquireFileLock,
  lockFileFor,
  pidAlive,
  releaseFileLock,
  withFileLock,
} from '../src/utils/file-lock';

let dir: string;
let target: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-file-lock-'));
  target = path.join(dir, 'session.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A pid that existed and has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const pid = Number(child.stdout);
  expect(pidAlive(pid)).toBe(false);
  return pid;
}

function writeLock(content: string, ageMs: number): void {
  const lock = lockFileFor(target);
  fs.writeFileSync(lock, content);
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(lock, when, when);
}

describe('file lock', () => {
  it('holds the lock for the callback and removes it after, also on throw', () => {
    const seen = withFileLock(target, () => fs.existsSync(lockFileFor(target)));
    expect(seen).toBe(true);
    expect(fs.existsSync(lockFileFor(target))).toBe(false);
    expect(() =>
      withFileLock(target, () => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(fs.existsSync(lockFileFor(target))).toBe(false);
  });

  it('times out loudly on a live holder, however old its lock, and leaves it alone', () => {
    writeLock(JSON.stringify({ pid: process.pid, token: 'theirs' }), 60_000);
    const started = Date.now();
    let caught: unknown;
    try {
      acquireFileLock(target, { timeoutMs: 150, staleMs: 10 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FileLockTimeoutError);
    expect((caught as FileLockTimeoutError).holderPid).toBe(process.pid);
    expect((caught as Error).message).toMatch(/Nothing was written/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(JSON.parse(fs.readFileSync(lockFileFor(target), 'utf8')).token).toBe('theirs');
  });

  it('reclaims an old lock whose owner is dead', () => {
    writeLock(JSON.stringify({ pid: deadPid(), token: 'dead' }), 5_000);
    const token = acquireFileLock(target, { timeoutMs: 500, staleMs: 1_000 });
    expect(JSON.parse(fs.readFileSync(lockFileFor(target), 'utf8')).token).toBe(token);
    releaseFileLock(target, token);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('does not reclaim a fresh lock of a dead owner, nor a fresh empty lock', () => {
    writeLock(JSON.stringify({ pid: deadPid(), token: 'dead' }), 0);
    expect(() => acquireFileLock(target, { timeoutMs: 100, staleMs: 60_000 })).toThrow(FileLockTimeoutError);
    writeLock('', 0);
    expect(() => acquireFileLock(target, { timeoutMs: 100, staleMs: 60_000 })).toThrow(FileLockTimeoutError);
  });

  it('reclaims an old empty lock (crash between create and write)', () => {
    writeLock('', 5_000);
    const token = acquireFileLock(target, { timeoutMs: 500, staleMs: 1_000 });
    releaseFileLock(target, token);
    expect(fs.existsSync(lockFileFor(target))).toBe(false);
  });

  it('release leaves a lock it does not own', () => {
    writeLock(JSON.stringify({ pid: process.pid, token: 'theirs' }), 0);
    releaseFileLock(target, 'mine');
    expect(fs.existsSync(lockFileFor(target))).toBe(true);
  });
});
