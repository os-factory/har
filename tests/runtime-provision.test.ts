import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExecResult, SystemOps } from '../src/runtime/exec';
import {
  detectEcosystem,
  iosFindProjectFile,
  iosProjectGenerator,
  provisionToolchain,
  ProvisionError,
  pythonProjectMinimum,
  pythonRequiresMinimum,
  pythonVersionGe,
  quoteEnvValue,
  toolchainReady,
} from '../src/runtime/provision';

interface FakeCall {
  cmd: string;
  args: string[];
  cwd?: string;
}

function fakeOps(options: {
  installed?: string[];
  exitCodes?: Record<string, number>;
  captures?: Record<string, string>;
} = {}): SystemOps & { calls: FakeCall[]; shellCalls: string[] } {
  const installed = new Set(options.installed ?? []);
  const calls: FakeCall[] = [];
  const shellCalls: string[] = [];
  const codeFor = (key: string): number => options.exitCodes?.[key] ?? 0;
  const result = (code: number): ExecResult => ({ code, stdout: '', stderr: '' });
  return {
    calls,
    shellCalls,
    which: (cmd) => (installed.has(path.basename(cmd)) || installed.has(cmd) ? `/usr/bin/${path.basename(cmd)}` : null),
    async run(cmd, args, opts) {
      calls.push({ cmd, args, cwd: opts?.cwd });
      return result(codeFor(`${path.basename(cmd)} ${args.join(' ')}`));
    },
    async runShell(command, opts) {
      calls.push({ cmd: 'bash -c', args: [command], cwd: opts?.cwd });
      shellCalls.push(command);
      return result(codeFor(command));
    },
    async capture(cmd, args) {
      const key = `${path.basename(cmd)} ${args.join(' ')}`;
      const value = options.captures?.[key];
      return value ?? null;
    },
  };
}

describe('runtime/provision', () => {
  let dir: string;
  let envFile: string;
  let logs: string[];

  const readEnv = () => fs.readFileSync(envFile, 'utf8');

  const provision = (ops: SystemOps, harnessEnv: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
    provisionToolchain({
      workDir: dir,
      envFile,
      harnessEnv,
      ops,
      log: (m) => logs.push(m),
      ...extra,
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-provision-'));
    envFile = path.join(dir, '.env.agent.1');
    fs.writeFileSync(envFile, '');
    logs = [];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('quoteEnvValue', () => {
    it('leaves plain tokens (paths, PATH lists) unquoted', () => {
      expect(quoteEnvValue('/usr/bin/node')).toBe('/usr/bin/node');
      expect(quoteEnvValue('/a/bin:/b/bin')).toBe('/a/bin:/b/bin');
      expect(quoteEnvValue('true')).toBe('true');
    });

    it('quotes values a bare `source` would split or expand', () => {
      expect(quoteEnvValue('My Scheme')).toBe("'My Scheme'");
      expect(quoteEnvValue('a$b')).toBe("'a$b'");
      expect(quoteEnvValue("O'Brien")).toBe(`'O'\\''Brien'`);
      expect(quoteEnvValue('')).toBe("''");
    });
  });

  describe('toolchainReady', () => {
    it('is ready when package.json and node_modules exist', () => {
      expect(toolchainReady(dir)).toBe(false);
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      expect(toolchainReady(dir)).toBe(false);
      fs.mkdirSync(path.join(dir, 'node_modules'));
      expect(toolchainReady(dir)).toBe(true);
    });

    it('is ready when a python venv exists', () => {
      fs.mkdirSync(path.join(dir, '.har', 'venv'), { recursive: true });
      expect(toolchainReady(dir)).toBe(true);
    });
  });

  describe('detectEcosystem', () => {
    it('honors an explicit HARNESS_ECOSYSTEM over manifests', () => {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      expect(detectEcosystem(dir, { HARNESS_ECOSYSTEM: 'python' })).toBe('python');
    });

    it.each([
      ['package.json', 'node'],
      ['pyproject.toml', 'python'],
      ['setup.py', 'python'],
      ['requirements.txt', 'python'],
      ['Pipfile', 'python'],
      ['go.mod', 'go'],
      ['Cargo.toml', 'rust'],
      ['pom.xml', 'java'],
      ['build.gradle.kts', 'java'],
      ['Gemfile', 'ruby'],
    ])('detects %s → %s', (manifest, expected) => {
      fs.writeFileSync(path.join(dir, manifest), '');
      expect(detectEcosystem(dir)).toBe(expected);
    });

    it('detects ios from HARNESS_XCODE_* config and none otherwise', () => {
      expect(detectEcosystem(dir)).toBe('none');
      expect(detectEcosystem(dir, { HARNESS_XCODE_SCHEME: 'App' })).toBe('ios');
    });

    it('prefers node over python when both manifests exist', () => {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      fs.writeFileSync(path.join(dir, 'pyproject.toml'), '');
      expect(detectEcosystem(dir)).toBe('node');
    });
  });

  describe('python version helpers', () => {
    it('parses requires-python specs', () => {
      expect(pythonRequiresMinimum('>=3.10,<4')).toBe('3.10');
      expect(pythonRequiresMinimum('~=3.11')).toBe('3.11');
      expect(pythonRequiresMinimum('==3.9.*')).toBe('3.9');
      expect(pythonRequiresMinimum('3.12')).toBe('3.12');
      expect(pythonRequiresMinimum('')).toBeNull();
    });

    it('compares versions numerically, not lexically', () => {
      expect(pythonVersionGe('3.10', '3.9')).toBe(true);
      expect(pythonVersionGe('3.9', '3.10')).toBe(false);
      expect(pythonVersionGe('3.10.1', '3.10')).toBe(true);
    });

    it('takes the higher of requires-python and .python-version', () => {
      fs.writeFileSync(path.join(dir, 'pyproject.toml'), 'requires-python = ">=3.9"\n');
      fs.writeFileSync(path.join(dir, '.python-version'), '3.12.1\n');
      expect(pythonProjectMinimum(dir)).toBe('3.12');
      fs.writeFileSync(path.join(dir, '.python-version'), '3.8\n');
      expect(pythonProjectMinimum(dir)).toBe('3.9');
    });
  });

  describe('ios helpers', () => {
    it('finds project files within depth 2, skipping Pods and xcodeproj internals', () => {
      fs.mkdirSync(path.join(dir, 'App', 'App.xcodeproj', 'project.xcworkspace'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'Pods', 'Deep.xcodeproj'), { recursive: true });
      expect(iosFindProjectFile(dir, '.xcodeproj')).toBe('App/App.xcodeproj');
      expect(iosFindProjectFile(dir, '.xcworkspace')).toBeNull();
    });

    it('maps generator manifests to their tool', () => {
      expect(iosProjectGenerator(dir)).toBe('');
      fs.writeFileSync(path.join(dir, 'Podfile'), '');
      expect(iosProjectGenerator(dir)).toBe('pod');
      fs.writeFileSync(path.join(dir, 'project.yml'), '');
      expect(iosProjectGenerator(dir)).toBe('xcodegen');
      fs.writeFileSync(path.join(dir, 'Project.swift'), '');
      expect(iosProjectGenerator(dir)).toBe('tuist');
    });
  });

  describe('provisionToolchain — node', () => {
    it('installs with the resolved manager and records toolchain env', async () => {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
      const ops = fakeOps({ installed: ['npm', 'node'] });

      const ecosystem = await provision(ops);

      expect(ecosystem).toBe('node');
      expect(ops.calls).toContainEqual({ cmd: 'npm', args: ['install', '--silent'], cwd: dir });
      const env = readEnv();
      expect(env).toContain('HARNESS_TOOLCHAIN_PROVISIONED=true');
      expect(env).toContain('HARNESS_ECOSYSTEM=node');
      expect(env).toContain('NODE_BIN=/usr/bin/node');
      expect(env).toContain('NPM_BIN=/usr/bin/npm');
      expect(env).toContain('HARNESS_NODE_PACKAGE_MANAGER=npm');
      expect(env).toContain("HARNESS_PKG_EXEC='npx --yes'");
      expect(env).toContain(`PATH=${path.join(dir, 'node_modules', '.bin')}:`);
      expect(logs).toContain('Installing Node dependencies with npm...');
    });

    it('HARNESS_INSTALL_CMD overrides the default install', async () => {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      const ops = fakeOps({ installed: ['npm', 'node'] });

      await provision(ops, { HARNESS_INSTALL_CMD: 'make deps' });

      expect(ops.shellCalls).toEqual(['make deps']);
      expect(ops.calls).not.toContainEqual({ cmd: 'npm', args: ['install', '--silent'], cwd: dir });
    });

    it('throws when the install fails (set -e parity)', async () => {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      const ops = fakeOps({ installed: ['npm'], exitCodes: { 'npm install --silent': 1 } });
      await expect(provision(ops)).rejects.toThrow(ProvisionError);
    });

    it('logs the substitution when the declared manager is missing', async () => {
      fs.writeFileSync(path.join(dir, 'package.json'), '{}');
      fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
      const ops = fakeOps({ installed: ['npm', 'node'] });

      await provision(ops);

      expect(logs).toContain(
        'Repo declares pnpm, which is not on PATH — installing with npm and leaving the lockfile untouched.',
      );
      expect(readEnv()).toContain('HARNESS_NODE_PACKAGE_MANAGER=npm');
    });
  });

  describe('provisionToolchain — other ecosystems', () => {
    it('none + HARNESS_INSTALL_CMD records custom', async () => {
      const ops = fakeOps();
      const ecosystem = await provision(ops, { HARNESS_INSTALL_CMD: './setup.sh' });
      expect(ecosystem).toBe('custom');
      expect(ops.shellCalls).toEqual(['./setup.sh']);
      expect(readEnv()).toContain('HARNESS_ECOSYSTEM=custom');
    });

    it('none without install cmd records none and hints', async () => {
      const ecosystem = await provision(fakeOps());
      expect(ecosystem).toBe('none');
      expect(readEnv()).toContain('HARNESS_ECOSYSTEM=none');
      expect(logs.join('\n')).toContain('No ecosystem manifest detected');
    });

    it('go downloads modules when go is installed, else records paths only', async () => {
      fs.writeFileSync(path.join(dir, 'go.mod'), 'module x');
      const withGo = fakeOps({ installed: ['go'] });
      await provision(withGo);
      expect(withGo.calls).toContainEqual({ cmd: 'go', args: ['mod', 'download'], cwd: dir });
      expect(readEnv()).toContain('GO_BIN=/usr/bin/go');

      fs.writeFileSync(envFile, '');
      logs = [];
      await provision(fakeOps());
      expect(logs).toContain('go not found on PATH — record paths only');
      expect(readEnv()).toContain('GO_BIN=go');
    });

    it('ruby runs bundle install and records bins', async () => {
      fs.writeFileSync(path.join(dir, 'Gemfile'), '');
      const ops = fakeOps({ installed: ['bundle', 'ruby'] });
      await provision(ops);
      expect(ops.calls).toContainEqual({ cmd: 'bundle', args: ['install', '--quiet'], cwd: dir });
      expect(readEnv()).toContain('RUBY_BIN=/usr/bin/ruby');
      expect(readEnv()).toContain('BUNDLE_BIN=/usr/bin/bundle');
    });

    it('java tolerates a failing HARNESS_INSTALL_CMD and prefers mvn over gradle', async () => {
      fs.writeFileSync(path.join(dir, 'pom.xml'), '');
      const ops = fakeOps({ installed: ['mvn', 'gradle'], exitCodes: { 'mvn deps': 1 } });
      await provision(ops, { HARNESS_INSTALL_CMD: 'mvn deps' });
      expect(readEnv()).toContain('HARNESS_ECOSYSTEM=java');
      expect(readEnv()).toContain('MVN_BIN=/usr/bin/mvn');
      expect(readEnv()).not.toContain('GRADLE_BIN');
    });
  });

  describe('provisionToolchain — ios', () => {
    it('fails naming the generator when it is not on PATH', async () => {
      fs.writeFileSync(path.join(dir, 'Project.swift'), '');
      const ops = fakeOps({ installed: ['xcodebuild'] });
      await expect(provision(ops, { HARNESS_ECOSYSTEM: 'ios' })).rejects.toThrow(
        'Xcode project generator not on PATH: tuist',
      );
      expect(logs.join('\n')).toContain('generates its Xcode project with tuist');
    });

    it('generates with xcodegen and records scheme/bundle config', async () => {
      fs.writeFileSync(path.join(dir, 'project.yml'), '');
      const ops = fakeOps({ installed: ['xcodegen', 'xcodebuild'] });
      await provision(ops, {
        HARNESS_ECOSYSTEM: 'ios',
        HARNESS_XCODE_SCHEME: 'My App',
        HARNESS_BUNDLE_ID: 'io.example.app',
      });
      expect(ops.calls).toContainEqual({ cmd: 'xcodegen', args: ['generate'], cwd: dir });
      const env = readEnv();
      expect(env).toContain("HARNESS_XCODE_SCHEME='My App'");
      expect(env).toContain('HARNESS_BUNDLE_ID=io.example.app');
      expect(env).toContain('XCODEBUILD_BIN=/usr/bin/xcodebuild');
    });

    it('runs pod install when Podfile exists and Pods/ does not', async () => {
      fs.writeFileSync(path.join(dir, 'Podfile'), '');
      const ops = fakeOps({ installed: ['pod', 'xcodebuild'] });
      await provision(ops, { HARNESS_ECOSYSTEM: 'ios' });
      expect(ops.calls).toContainEqual({ cmd: 'pod', args: ['install'], cwd: dir });
    });

    it('skips generators entirely when HARNESS_INSTALL_CMD is set', async () => {
      fs.writeFileSync(path.join(dir, 'Podfile'), '');
      const ops = fakeOps({ installed: ['xcodebuild'] });
      await provision(ops, { HARNESS_ECOSYSTEM: 'ios', HARNESS_INSTALL_CMD: 'make ios' });
      expect(ops.shellCalls).toEqual(['make ios']);
      expect(ops.calls.filter((c) => c.cmd === 'pod')).toHaveLength(0);
    });
  });

  describe('provisionToolchain — python fallbacks', () => {
    it('records python3 and skips venv when no interpreter is found', async () => {
      fs.writeFileSync(path.join(dir, 'requirements.txt'), '');
      const ops = fakeOps({ installed: [] });
      await provision(ops);
      expect(logs).toContain('No suitable Python interpreter found — skipping venv provisioning');
      expect(readEnv()).toContain('HARNESS_ECOSYSTEM=python');
      expect(readEnv()).toContain('PYTHON_BIN=python3');
    });
  });

  describe('provisionToolchain — monorepo root', () => {
    it('installs root deps when the project lives in a subdirectory', async () => {
      const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'har-worktree-'));
      try {
        fs.writeFileSync(path.join(worktree, 'package.json'), '{}');
        const ops = fakeOps({ installed: ['npm', 'node'] });
        await provision(ops, { HARNESS_INSTALL_CMD: 'true' }, { worktreeDir: worktree, relPrefix: 'apps/web/' });
        expect(ops.calls).toContainEqual({ cmd: 'npm', args: ['install', '--silent'], cwd: worktree });
        expect(logs.join('\n')).toContain(`Installing monorepo root dependencies in ${worktree} with npm...`);
      } finally {
        fs.rmSync(worktree, { recursive: true, force: true });
      }
    });

    it('skips the root install when node_modules already exists', async () => {
      const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'har-worktree-'));
      try {
        fs.writeFileSync(path.join(worktree, 'package.json'), '{}');
        fs.mkdirSync(path.join(worktree, 'node_modules'));
        const ops = fakeOps({ installed: ['npm'] });
        await provision(ops, { HARNESS_INSTALL_CMD: 'true' }, { worktreeDir: worktree, relPrefix: 'apps/web/' });
        expect(ops.calls.filter((c) => c.cwd === worktree)).toHaveLength(0);
      } finally {
        fs.rmSync(worktree, { recursive: true, force: true });
      }
    });
  });
});
