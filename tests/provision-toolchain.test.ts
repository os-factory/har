import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from '../src/utils/shell';
import { resolveTemplatesDir } from '../src/utils/paths';

const PROFILES = ['har-boilerplate', 'har-boilerplate-cli', 'har-boilerplate-ios'] as const;

describe('provision-toolchain.sh template contract', () => {
  for (const profile of PROFILES) {
    it(`${profile} ships provision-toolchain.sh with valid bash syntax`, () => {
      const scriptPath = path.join(resolveTemplatesDir(), profile, 'provision-toolchain.sh');
      expect(fs.existsSync(scriptPath)).toBe(true);
      const result = run(`bash -n "${scriptPath}"`);
      expect(result.code).toBe(0);
    });

    it(`${profile} launch.sh invokes provision-toolchain.sh`, () => {
      const launchPath = path.join(resolveTemplatesDir(), profile, 'launch.sh');
      const content = fs.readFileSync(launchPath, 'utf8');
      expect(content).toContain('provision-toolchain.sh');
      expect(content).toContain('HAR_WORK_DIR');
      expect(content).toContain('HAR_ENV_FILE');
    });

    it(`${profile} harness.env documents HARNESS_ECOSYSTEM`, () => {
      const harnessEnvPath = path.join(resolveTemplatesDir(), profile, 'harness.env');
      const content = fs.readFileSync(harnessEnvPath, 'utf8');
      expect(content).toContain('HARNESS_ECOSYSTEM');
      if (profile !== 'har-boilerplate-ios') {
        expect(content).not.toContain('HARNESS_PYTHON_VENV_DIR');
      }
    });
  }

  it('auto-detects python and writes PYTHON_BIN to agent env', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-pt-python-'));
    const scriptPath = path.join(resolveTemplatesDir(), 'har-boilerplate-cli', 'provision-toolchain.sh');
    const harnessEnv = path.join(resolveTemplatesDir(), 'har-boilerplate-cli', 'harness.env');

    fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), '# empty fixture\n');

    const envFile = path.join(tmpDir, '.env.agent.1');
    fs.writeFileSync(envFile, 'AGENT_ID=1\nREPO_ROOT=' + tmpDir + '\n');

    const result = run(
      `set -a && . "${harnessEnv}" && set +a && ` +
        `HAR_WORK_DIR="${tmpDir}" HAR_ENV_FILE="${envFile}" HAR_AGENT_ID=1 ` +
        `bash "${scriptPath}"`,
    );

    expect(result.code).toBe(0);
    const envContent = fs.readFileSync(envFile, 'utf8');
    expect(envContent).toContain('HARNESS_ECOSYSTEM=python');
    expect(envContent).toContain('PYTHON_BIN=');
    if (envContent.includes('VIRTUAL_ENV=')) {
      expect(fs.existsSync(path.join(tmpDir, '.har/venv'))).toBe(true);
    }
  });

  it('writes values with spaces so the agent env file can be sourced', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-pt-quoting-'));
    const scriptPath = path.join(resolveTemplatesDir(), 'har-boilerplate-ios', 'provision-toolchain.sh');
    const envFile = path.join(tmpDir, '.env.agent.1');
    fs.writeFileSync(envFile, `AGENT_ID=1\nREPO_ROOT=${tmpDir}\n`);

    const provision = run(
      `HARNESS_ECOSYSTEM=ios HARNESS_XCODE_SCHEME="My App" ` +
        `HAR_WORK_DIR="${tmpDir}" HAR_ENV_FILE="${envFile}" HAR_AGENT_ID=1 ` +
        `bash "${scriptPath}"`,
    );
    expect(provision.code).toBe(0);

    // An unquoted `HARNESS_XCODE_SCHEME=My App` would run `App` as a command.
    const sourced = run(`set -a && . "${envFile}" && set +a && printf '%s' "$HARNESS_XCODE_SCHEME"`);
    expect(sourced.code).toBe(0);
    expect(sourced.stdout).toBe('My App');
  });

  it('auto-detects node and writes NPM_BIN to agent env', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-pt-node-'));
    const scriptPath = path.join(resolveTemplatesDir(), 'har-boilerplate-cli', 'provision-toolchain.sh');
    const harnessEnv = path.join(resolveTemplatesDir(), 'har-boilerplate-cli', 'harness.env');

    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'fixture', scripts: { test: 'true' } }),
    );

    const envFile = path.join(tmpDir, '.env.agent.1');
    fs.writeFileSync(envFile, 'AGENT_ID=1\nREPO_ROOT=' + tmpDir + '\n');

    const result = run(
      `set -a && . "${harnessEnv}" && set +a && ` +
        `HAR_WORK_DIR="${tmpDir}" HAR_ENV_FILE="${envFile}" HAR_AGENT_ID=1 ` +
        `bash "${scriptPath}"`,
    );

    expect(result.code).toBe(0);
    const envContent = fs.readFileSync(envFile, 'utf8');
    expect(envContent).toContain('HARNESS_ECOSYSTEM=node');
    expect(envContent).toContain('NPM_BIN=');
    expect(envContent).toContain('NODE_BIN=');
    expect(envContent).toContain('HARNESS_TOOLCHAIN_PROVISIONED=true');
  });

  // This repo dogfoods HAR: its own harnesses are scaffolded copies that only move
  // when someone runs `har env maintain`, so a template fix does not reach them.
  // Env-file quoting is not cosmetic drift — an unquoted value breaks `source` for
  // every contributor whose PATH or repo path contains a space.
  for (const harness of ['.har', 'control/.har'] as const) {
    it(`${harness}/provision-toolchain.sh quotes values it appends to the agent env`, () => {
      const scriptPath = path.join(process.cwd(), harness, 'provision-toolchain.sh');
      const content = fs.readFileSync(scriptPath, 'utf8');
      expect(content).toContain("printf '%s=%q\\n'");
      expect(content).not.toContain("printf '%s=%s\\n'");
    });
  }

  it('resolves the package manager from lockfile, packageManager field, and override', () => {
    const harnessEnv = path.join(resolveTemplatesDir(), 'har-boilerplate-cli', 'harness.env');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-pt-pm-'));

    const declared = (files: Record<string, string>, env = ''): string => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      fs.mkdirSync(tmpDir, { recursive: true });
      for (const [name, body] of Object.entries(files)) {
        fs.writeFileSync(path.join(tmpDir, name), body);
      }
      // A sourced slot env exports HARNESS_NODE_PACKAGE_MANAGER; drop it so the
      // detection order is what is under test, not the ambient pin.
      const result = run(
        `env -u HARNESS_NODE_PACKAGE_MANAGER ${env} ` +
          `bash -c '. "${harnessEnv}" && har_node_declared_package_manager "${tmpDir}"'`,
      );
      expect(result.code).toBe(0);
      return result.stdout.trim();
    };

    const pkg = JSON.stringify({ name: 'fixture' });
    expect(declared({ 'package.json': pkg, 'bun.lock': '' })).toBe('bun');
    expect(declared({ 'package.json': pkg, 'bun.lockb': '' })).toBe('bun');
    expect(declared({ 'package.json': pkg, 'pnpm-lock.yaml': '' })).toBe('pnpm');
    expect(declared({ 'package.json': pkg, 'yarn.lock': '' })).toBe('yarn');
    expect(declared({ 'package.json': pkg, 'package-lock.json': '{}' })).toBe('npm');
    expect(declared({ 'package.json': pkg })).toBe('');

    // The packageManager field outranks the lockfile.
    expect(
      declared({
        'package.json': JSON.stringify({ name: 'fixture', packageManager: 'bun@1.3.14' }),
        'package-lock.json': '{}',
      }),
    ).toBe('bun');

    // An explicit override outranks everything.
    expect(
      declared({ 'package.json': pkg, 'bun.lock': '' }, 'HARNESS_NODE_PACKAGE_MANAGER=pnpm'),
    ).toBe('pnpm');
  });

  it('maps each package manager to its runner and lockfile', () => {
    const harnessEnv = path.join(resolveTemplatesDir(), 'har-boilerplate-cli', 'harness.env');
    const result = run(
      `bash -c '. "${harnessEnv}" && for m in npm bun pnpm yarn; do ` +
        `echo "$m|$(har_pkg_exec "$m")|$(har_node_lockfile "$m")"; done'`,
    );

    expect(result.code).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual([
      'npm|npx --yes|package-lock.json',
      'bun|bunx|bun.lock',
      'pnpm|pnpm dlx|pnpm-lock.yaml',
      'yarn|yarn dlx|yarn.lock',
    ]);
  });

  it('falls back to an installed manager and leaves the declared lockfile alone', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-pt-fallback-'));
    const harnessEnv = path.join(resolveTemplatesDir(), 'har-boilerplate-cli', 'harness.env');

    // A repo that declares pnpm, installed by npm because pnpm is missing: the
    // substitute writes package-lock.json, which must not survive the install.
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'fixture' }));
    fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    const substitute = run(
      `bash -c '. "${harnessEnv}" && npm() { : > package-lock.json; } && ` +
        `har_node_install "${tmpDir}" npm pnpm'`,
    );

    expect(substitute.code).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'pnpm-lock.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'package-lock.json'))).toBe(false);

    // The declared manager keeps its own lockfile.
    const declaredRun = run(
      `bash -c '. "${harnessEnv}" && npm() { : > package-lock.json; } && ` +
        `har_node_install "${tmpDir}" npm npm'`,
    );

    expect(declaredRun.code).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'package-lock.json'))).toBe(true);
  });

  it('ships the package manager helpers identically in harness.env and provision-toolchain.sh', () => {
    const extract = (file: string): string => {
      const content = fs.readFileSync(file, 'utf8');
      const start = content.indexOf('# ── Node package manager helpers');
      const end = content.indexOf('  echo "npx --yes"\n}', start);
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return content.slice(start, end);
    };

    for (const profile of PROFILES) {
      const dir = path.join(resolveTemplatesDir(), profile);
      expect(extract(path.join(dir, 'harness.env'))).toBe(
        extract(path.join(dir, 'provision-toolchain.sh')),
      );
    }
  });

  it('verify.sh dispatches stock smoke by ecosystem', () => {
    for (const profile of ['har-boilerplate', 'har-boilerplate-cli'] as const) {
      const verifyPath = path.join(resolveTemplatesDir(), profile, 'verify.sh');
      const content = fs.readFileSync(verifyPath, 'utf8');
      expect(content).toContain('run_quick_smoke');
      expect(content).toContain('HARNESS_ECOSYSTEM');
      expect(content).toContain('python-compile');
      expect(content).toContain('go-build');
      expect(content).toContain('rust-check');
      expect(content).not.toMatch(/run_step "[^"]+" "npm /);
    }
  });
});
