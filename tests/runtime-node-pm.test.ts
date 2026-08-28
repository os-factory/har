import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExecResult, SystemOps } from '../src/runtime/exec';
import {
  declaredNodePackageManager,
  nodeInstall,
  nodeLockfile,
  nodePackageManager,
  pkgExec,
} from '../src/runtime/node-pm';

interface FakeCall {
  cmd: string;
  args: string[];
  cwd?: string;
}

function fakeOps(options: {
  installed?: string[];
  exitCode?: number;
  onRun?: (call: FakeCall) => void;
}): SystemOps & { calls: FakeCall[] } {
  const installed = new Set(options.installed ?? []);
  const calls: FakeCall[] = [];
  const result = (code: number): ExecResult => ({ code, stdout: '', stderr: '' });
  return {
    calls,
    which: (cmd) => (installed.has(cmd) ? `/usr/bin/${cmd}` : null),
    async run(cmd, args, opts) {
      const call = { cmd, args, cwd: opts?.cwd };
      calls.push(call);
      options.onRun?.(call);
      return result(options.exitCode ?? 0);
    },
    async runShell(command, opts) {
      calls.push({ cmd: 'bash -c', args: [command], cwd: opts?.cwd });
      return result(options.exitCode ?? 0);
    },
    async capture() {
      return null;
    },
  };
}

describe('runtime/node-pm', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-node-pm-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('declaredNodePackageManager', () => {
    it('prefers HARNESS_NODE_PACKAGE_MANAGER over everything', () => {
      fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
      expect(declaredNodePackageManager(dir, { HARNESS_NODE_PACKAGE_MANAGER: 'bun' })).toBe('bun');
    });

    it('reads package.json packageManager field', () => {
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ packageManager: 'pnpm@9.1.0' }),
      );
      expect(declaredNodePackageManager(dir)).toBe('pnpm');
    });

    it('falls back to lockfiles in bun → pnpm → yarn → npm order', () => {
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{}');
      expect(declaredNodePackageManager(dir)).toBe('npm');
      fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
      expect(declaredNodePackageManager(dir)).toBe('yarn');
      fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
      expect(declaredNodePackageManager(dir)).toBe('pnpm');
      fs.writeFileSync(path.join(dir, 'bun.lockb'), '');
      expect(declaredNodePackageManager(dir)).toBe('bun');
    });

    it('returns empty string when the repo says nothing', () => {
      expect(declaredNodePackageManager(dir)).toBe('');
    });
  });

  describe('nodePackageManager', () => {
    it('uses the declared manager when it is on PATH', () => {
      fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
      const ops = fakeOps({ installed: ['npm', 'pnpm'] });
      expect(nodePackageManager(dir, {}, ops)).toBe('pnpm');
    });

    it('substitutes an installed manager when the declared one is missing', () => {
      fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
      const ops = fakeOps({ installed: ['bun'] });
      expect(nodePackageManager(dir, {}, ops)).toBe('bun');
    });

    it('follows fallback preference order npm → bun → pnpm → yarn', () => {
      const ops = fakeOps({ installed: ['yarn', 'bun'] });
      expect(nodePackageManager(dir, {}, ops)).toBe('bun');
    });

    it('echoes the declared manager when nothing is installed', () => {
      fs.writeFileSync(path.join(dir, 'yarn.lock'), '');
      const ops = fakeOps({ installed: [] });
      expect(nodePackageManager(dir, {}, ops)).toBe('yarn');
    });

    it('defaults to npm when nothing is declared or installed', () => {
      const ops = fakeOps({ installed: [] });
      expect(nodePackageManager(dir, {}, ops)).toBe('npm');
    });
  });

  describe('nodeLockfile', () => {
    it('maps each manager to the lockfile it writes', () => {
      expect(nodeLockfile('bun')).toBe('bun.lock');
      expect(nodeLockfile('npm')).toBe('package-lock.json');
      expect(nodeLockfile('pnpm')).toBe('pnpm-lock.yaml');
      expect(nodeLockfile('yarn')).toBe('yarn.lock');
      expect(nodeLockfile('deno')).toBe('');
    });
  });

  describe('nodeInstall', () => {
    it('runs <manager> install --silent in the directory', async () => {
      const ops = fakeOps({ installed: ['npm'] });
      const code = await nodeInstall(dir, 'npm', 'npm', ops);
      expect(code).toBe(0);
      expect(ops.calls).toEqual([{ cmd: 'npm', args: ['install', '--silent'], cwd: dir }]);
    });

    it('removes the substitute lockfile the install created', async () => {
      const ops = fakeOps({
        installed: ['bun'],
        onRun: () => fs.writeFileSync(path.join(dir, 'bun.lock'), ''),
      });
      await nodeInstall(dir, 'bun', 'npm', ops);
      expect(fs.existsSync(path.join(dir, 'bun.lock'))).toBe(false);
    });

    it('keeps a substitute lockfile that existed before the install', async () => {
      fs.writeFileSync(path.join(dir, 'bun.lock'), 'pre-existing');
      const ops = fakeOps({ installed: ['bun'] });
      await nodeInstall(dir, 'bun', 'npm', ops);
      expect(fs.readFileSync(path.join(dir, 'bun.lock'), 'utf8')).toBe('pre-existing');
    });

    it('propagates the install exit code', async () => {
      const ops = fakeOps({ installed: ['npm'], exitCode: 7 });
      expect(await nodeInstall(dir, 'npm', '', ops)).toBe(7);
    });
  });

  describe('pkgExec', () => {
    it('maps managers to their runner', () => {
      const ops = fakeOps({ installed: [] });
      expect(pkgExec('bun', {}, ops)).toBe('bunx');
      expect(pkgExec('pnpm', {}, ops)).toBe('pnpm dlx');
      expect(pkgExec('yarn', {}, ops)).toBe('yarn dlx');
      expect(pkgExec('npm', {}, ops)).toBe('npx --yes');
    });

    it('resolves from HARNESS_NODE_PACKAGE_MANAGER when no manager is given', () => {
      const ops = fakeOps({ installed: [] });
      expect(pkgExec(undefined, { HARNESS_NODE_PACKAGE_MANAGER: 'pnpm' }, ops)).toBe('pnpm dlx');
    });

    it('probes PATH (npx, bunx, pnpm) when nothing is declared', () => {
      expect(pkgExec(undefined, {}, fakeOps({ installed: ['bunx', 'pnpm'] }))).toBe('bunx');
      expect(pkgExec(undefined, {}, fakeOps({ installed: ['pnpm'] }))).toBe('pnpm dlx');
      expect(pkgExec(undefined, {}, fakeOps({ installed: [] }))).toBe('npx --yes');
    });
  });
});
