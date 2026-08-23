import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from '../src/utils/shell';
import { resolveTemplatesDir } from '../src/utils/paths';

const PROFILES = ['har-boilerplate', 'har-boilerplate-cli', 'har-boilerplate-ios'] as const;

// Single source since the bundle composition: every profile is served the same
// script by the shared-kernel runtime bundle.
const PROVISION_SCRIPT = path.join(
  resolveTemplatesDir(),
  'runtime-bundles',
  'shared-kernel',
  'provision-toolchain.sh',
);

// Single source for the node package-manager helpers (har_node_*, har_pkg_exec).
const NODE_PM_LIB = path.join(
  resolveTemplatesDir(),
  'runtime-bundles',
  'shared-kernel',
  'lib',
  'node-pm.sh',
);

describe('provision-toolchain.sh template contract', () => {
  it('shared-kernel ships provision-toolchain.sh with valid bash syntax', () => {
    expect(fs.existsSync(PROVISION_SCRIPT)).toBe(true);
    const result = run(`bash -n "${PROVISION_SCRIPT}"`);
    expect(result.code).toBe(0);
  });

  for (const profile of PROFILES) {
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
    const scriptPath = PROVISION_SCRIPT;
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
    const scriptPath = PROVISION_SCRIPT;
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
    const scriptPath = PROVISION_SCRIPT;
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
          `bash -c '. "${NODE_PM_LIB}" && har_node_declared_package_manager "${tmpDir}"'`,
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
    const result = run(
      `bash -c '. "${NODE_PM_LIB}" && for m in npm bun pnpm yarn; do ` +
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

    // A repo that declares pnpm, installed by npm because pnpm is missing: the
    // substitute writes package-lock.json, which must not survive the install.
    fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ name: 'fixture' }));
    fs.writeFileSync(path.join(tmpDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');

    const substitute = run(
      `bash -c '. "${NODE_PM_LIB}" && npm() { : > package-lock.json; } && ` +
        `har_node_install "${tmpDir}" npm pnpm'`,
    );

    expect(substitute.code).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'pnpm-lock.yaml'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'package-lock.json'))).toBe(false);

    // The declared manager keeps its own lockfile.
    const declaredRun = run(
      `bash -c '. "${NODE_PM_LIB}" && npm() { : > package-lock.json; } && ` +
        `har_node_install "${tmpDir}" npm npm'`,
    );

    expect(declaredRun.code).toBe(0);
    expect(fs.existsSync(path.join(tmpDir, 'package-lock.json'))).toBe(true);
  });

  it('defines the node package-manager helpers in exactly one template file', () => {
    const helperDefs = /^(HAR_NODE_PACKAGE_MANAGERS=|har_node_declared_package_manager\(\)|har_node_package_manager\(\)|har_node_lockfile\(\)|har_node_install\(\)|har_pkg_exec\(\))/m;

    // The lib is the single source and defines the full helper set.
    const lib = fs.readFileSync(NODE_PM_LIB, 'utf8');
    for (const fn of [
      'har_node_declared_package_manager()',
      'har_node_package_manager()',
      'har_node_lockfile()',
      'har_node_install()',
      'har_pkg_exec()',
    ]) {
      expect(lib).toContain(fn);
    }

    // No other template file defines any of the helpers; harness.env is config.
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });
    const offenders = walk(resolveTemplatesDir()).filter(
      (file) => file !== NODE_PM_LIB && helperDefs.test(fs.readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);

    // Every consumer sources the lib: agent-slot.sh serves the .har scripts,
    // provision-toolchain.sh sources it as a subprocess.
    for (const profile of PROFILES) {
      const agentSlot = fs.readFileSync(
        path.join(resolveTemplatesDir(), profile, 'agent-slot.sh'),
        'utf8',
      );
      expect(agentSlot).toContain('lib/node-pm.sh');
      const harnessEnv = fs.readFileSync(
        path.join(resolveTemplatesDir(), profile, 'harness.env'),
        'utf8',
      );
      expect(harnessEnv).not.toMatch(/har_node_|har_pkg_exec/);
    }
    expect(fs.readFileSync(PROVISION_SCRIPT, 'utf8')).toContain('lib/node-pm.sh');
  });

  it('verify.sh delegates to the stage-registry runner (no inline ecosystem tables)', () => {
    for (const profile of ['har-boilerplate', 'har-boilerplate-cli'] as const) {
      const verifyPath = path.join(resolveTemplatesDir(), profile, 'verify.sh');
      const content = fs.readFileSync(verifyPath, 'utf8');
      expect(content).toContain('lib/verify-runner.mjs');
      expect(content).not.toContain('run_quick_smoke');
      expect(content).not.toContain('run_full_checks');
    }
  });

  describe('Python interpreter resolution', () => {
    const scriptPath = PROVISION_SCRIPT;

    const sourcePythonHelpers = (body: string): ReturnType<typeof run> =>
      run(
        // Sourcing from a stream loses BASH_SOURCE, so point the script at the
        // node-pm lib explicitly.
        `HAR_WORK_DIR="." HAR_ENV_FILE=/dev/null HAR_AGENT_ID= HAR_WORKTREE_DIR= HAR_REL_PREFIX= ` +
          `HAR_NODE_PM_LIB="${NODE_PM_LIB}" ` +
          `bash -c 'source <(sed "/^append_env \\"HARNESS_TOOLCHAIN_PROVISIONED\\"/,\\$d" "${scriptPath}") && ${body}'`,
      );

    it('compares Python versions and parses requires-python minimums', () => {
      const ge = sourcePythonHelpers(
        'har_python_version_ge 3.12.1 3.11 && har_python_version_ge 3.11 3.11 && ! har_python_version_ge 3.10 3.11',
      );
      expect(ge.code).toBe(0);

      const specs = sourcePythonHelpers(
        'echo "$(har_python_requires_minimum ">=3.11, <3.14")" && ' +
          'echo "$(har_python_requires_minimum "~=3.12.0")" && ' +
          'echo "$(har_python_requires_minimum "==3.10.*")"',
      );
      expect(specs.code).toBe(0);
      expect(specs.stdout.trim().split('\n')).toEqual(['3.11', '3.12', '3.10']);
    });

    it('derives the project minimum from requires-python and .python-version', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-pt-py-min-'));
      fs.writeFileSync(
        path.join(tmpDir, 'pyproject.toml'),
        '[project]\nrequires-python = ">=3.11, <3.14"\n',
      );
      fs.writeFileSync(path.join(tmpDir, '.python-version'), '3.13\n');

      const result = sourcePythonHelpers(`echo "$(har_python_project_minimum "${tmpDir}")"`);
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('3.13');
    });

    it('warns when the resolved interpreter is older than requires-python', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-pt-py-warn-'));
      const script = PROVISION_SCRIPT;
      const harnessEnv = path.join(resolveTemplatesDir(), 'har-boilerplate-cli', 'harness.env');
      const fakeBin = path.join(tmpDir, 'bin');

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(path.join(fakeBin, 'uv'), '#!/usr/bin/env bash\nexit 1\n', { mode: 0o755 });

      fs.writeFileSync(
        path.join(tmpDir, 'pyproject.toml'),
        '[project]\nname = "fixture"\nversion = "0.0.0"\nrequires-python = ">=99.0"\n',
      );
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), '# empty fixture\n');

      const envFile = path.join(tmpDir, '.env.agent.1');
      fs.writeFileSync(envFile, `AGENT_ID=1\nREPO_ROOT=${tmpDir}\n`);

      const result = run(
        `set -a && . "${harnessEnv}" && set +a && ` +
          `PATH="${fakeBin}:$PATH" HARNESS_INSTALL_CMD=true ` +
          `HAR_WORK_DIR="${tmpDir}" HAR_ENV_FILE="${envFile}" HAR_AGENT_ID=1 ` +
          `bash "${script}" 2>&1`,
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('WARNING: resolved Python');
      expect(result.stdout).toContain('older than required 99.0');
    });

    it('flags an existing venv for recreation when its Python is below requires-python', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-pt-py-recreate-'));
      const venvPython = path.join(tmpDir, '.har', 'venv', 'bin', 'python');

      fs.mkdirSync(path.dirname(venvPython), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'pyproject.toml'),
        '[project]\nname = "fixture"\nversion = "0.0.0"\nrequires-python = ">=3.11"\n',
      );

      const check = sourcePythonHelpers(
        `project_min="$(har_python_project_minimum "${tmpDir}")" && ` +
          `venv_ver="3.9.6" && ` +
          `if ! har_python_version_ge "$venv_ver" "$project_min"; then echo recreate; fi`,
      );

      expect(check.code).toBe(0);
      expect(check.stdout.trim()).toBe('recreate');
    });

    it('detects uv-managed projects from uv.lock and [tool.uv]', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-pt-py-uv-detect-'));
      const lockOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'har-pt-py-uv-lock-'));
      const toolOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'har-pt-py-uv-tool-'));

      fs.writeFileSync(path.join(lockOnly, 'uv.lock'), '# lock\n');
      fs.writeFileSync(
        path.join(toolOnly, 'pyproject.toml'),
        '[project]\nname = "fixture"\nversion = "0.0.0"\n\n[tool.uv]\n',
      );

      const result = sourcePythonHelpers(
        `har_python_is_uv_project "${lockOnly}" && echo lock && ` +
          `har_python_is_uv_project "${toolOnly}" && echo tool && ` +
          `har_python_is_uv_project "${tmpDir}" || echo plain`,
      );

      expect(result.code).toBe(0);
      expect(result.stdout.trim().split('\n')).toEqual(['lock', 'tool', 'plain']);
    });

    it('routes uv-managed projects through uv venv/sync when uv is on PATH', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-pt-py-uv-'));
      const script = PROVISION_SCRIPT;
      const harnessEnv = path.join(resolveTemplatesDir(), 'har-boilerplate-cli', 'harness.env');
      const fakeBin = path.join(tmpDir, 'bin');
      const fakeUv = path.join(fakeBin, 'uv');
      const uvLog = path.join(tmpDir, 'uv.log');

      fs.mkdirSync(fakeBin, { recursive: true });
      fs.writeFileSync(
        fakeUv,
        [
          '#!/usr/bin/env bash',
          'set -euo pipefail',
          `log=${JSON.stringify(uvLog)}`,
          'printf \'%s\\n\' "$*" >> "$log"',
          'case "$1" in',
          '  python)',
          '    [ "$2" = find ] || exit 1',
          '    shift 2',
          '    [ -n "${1:-}" ] && printf \'%s\\n\' "$1" >> "$log"',
          '    command -v python3',
          '    ;;',
          '  venv)',
          '    venv_dir=""',
          '    for arg in "$@"; do',
          '      case "$arg" in',
          '        /*|./*) venv_dir="$arg" ;;',
          '      esac',
          '    done',
          '    [ -n "$venv_dir" ] || exit 1',
          '    mkdir -p "$venv_dir/bin"',
          '    ln -sf "$(command -v python3)" "$venv_dir/bin/python"',
          '    printf \'%s\\n\' \'# stub activate for harness tests\' > "$venv_dir/bin/activate"',
          '    ;;',
          '  sync)',
          '    exit 0',
          '    ;;',
          '  *)',
          '    exit 1',
          '    ;;',
          'esac',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );

      fs.writeFileSync(
        path.join(tmpDir, 'pyproject.toml'),
        '[project]\nname = "fixture"\nversion = "0.0.0"\nrequires-python = ">=3.11"\n\n[tool.uv]\n',
      );
      fs.writeFileSync(path.join(tmpDir, 'uv.lock'), '# uv lock fixture\n');
      fs.writeFileSync(path.join(tmpDir, 'requirements.txt'), '# empty fixture\n');

      const envFile = path.join(tmpDir, '.env.agent.1');
      fs.writeFileSync(envFile, `AGENT_ID=1\nREPO_ROOT=${tmpDir}\n`);

      const result = run(
        `set -a && . "${harnessEnv}" && set +a && ` +
          `PATH="${fakeBin}:$PATH" ` +
          `HAR_WORK_DIR="${tmpDir}" HAR_ENV_FILE="${envFile}" HAR_AGENT_ID=1 ` +
          `bash "${script}" 2>&1`,
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Creating Python venv with uv');
      expect(result.stdout).toContain('Syncing Python dependencies with uv');
      const envContent = fs.readFileSync(envFile, 'utf8');
      expect(envContent).toContain('PYTHON_BIN=');
      const uvLogContent = fs.readFileSync(uvLog, 'utf8');
      expect(uvLogContent).toContain('venv');
      expect(uvLogContent).toContain('sync');
    });
  });

  describe('iOS project generation', () => {
    const scriptPath = PROVISION_SCRIPT;

    /** Fixture work dir with a fake bin dir on PATH and an agent env file. */
    const iosFixture = (name: string): { dir: string; bin: string; envFile: string; log: string } => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `har-pt-ios-${name}-`));
      const bin = path.join(dir, 'fakebin');
      const envFile = path.join(dir, '.env.agent.1');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(envFile, `AGENT_ID=1\nREPO_ROOT=${dir}\n`);
      return { dir, bin, envFile, log: path.join(dir, 'generator.log') };
    };

    /** Stub generator that records its argv and creates the project it would generate. */
    const stubGenerator = (bin: string, tool: string, log: string, project = ''): void => {
      const create = project ? `mkdir -p "${project}"\n` : '';
      fs.writeFileSync(
        path.join(bin, tool),
        `#!/usr/bin/env bash\nprintf '%s %s\\n' "${tool}" "$*" >> "${log}"\n${create}exit 0\n`,
        { mode: 0o755 },
      );
    };

    const provision = (
      fixture: { dir: string; bin: string; envFile: string },
      opts: { pathPrefix?: string; installCmd?: string } = {},
    ): ReturnType<typeof run> => {
      // A bare system PATH for the "generator missing" cases: the machine
      // running the tests may well have tuist or xcodegen installed elsewhere.
      const pathValue =
        opts.pathPrefix === undefined ? `${fixture.bin}:/usr/bin:/bin` : opts.pathPrefix;
      const install = opts.installCmd === undefined ? '' : `HARNESS_INSTALL_CMD=${opts.installCmd} `;
      return run(
        `PATH="${pathValue}" HARNESS_ECOSYSTEM=ios ${install}` +
          `HAR_WORK_DIR="${fixture.dir}" HAR_ENV_FILE="${fixture.envFile}" HAR_AGENT_ID=1 ` +
          `bash "${scriptPath}" 2>&1`,
      );
    };

    it('runs xcodegen when project.yml has no generated .xcodeproj', () => {
      const fixture = iosFixture('xcodegen');
      fs.writeFileSync(path.join(fixture.dir, 'project.yml'), 'name: Fixture\n');
      stubGenerator(fixture.bin, 'xcodegen', fixture.log, path.join(fixture.dir, 'Fixture.xcodeproj'));

      const result = provision(fixture);

      expect(result.code).toBe(0);
      expect(fs.readFileSync(fixture.log, 'utf8')).toContain('xcodegen generate');
    });

    it('runs tuist generate for a Project.swift repo', () => {
      const fixture = iosFixture('tuist');
      fs.writeFileSync(path.join(fixture.dir, 'Project.swift'), '// tuist fixture\n');
      stubGenerator(fixture.bin, 'tuist', fixture.log, path.join(fixture.dir, 'Fixture.xcodeproj'));

      const result = provision(fixture);

      expect(result.code).toBe(0);
      expect(fs.readFileSync(fixture.log, 'utf8')).toContain('tuist generate --no-open');
    });

    it('fails naming the generator when it is not on PATH', () => {
      const fixture = iosFixture('no-tuist');
      fs.writeFileSync(path.join(fixture.dir, 'Project.swift'), '// tuist fixture\n');

      const result = provision(fixture, { pathPrefix: '/usr/bin:/bin' });

      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain('tuist');
      expect(result.stdout).toContain('HARNESS_INSTALL_CMD');
    });

    it('installs CocoaPods dependencies when Pods/ is missing', () => {
      const fixture = iosFixture('pods');
      fs.writeFileSync(path.join(fixture.dir, 'Podfile'), "platform :ios, '17.0'\n");
      stubGenerator(fixture.bin, 'pod', fixture.log, path.join(fixture.dir, 'Fixture.xcworkspace'));

      const result = provision(fixture);

      expect(result.code).toBe(0);
      expect(fs.readFileSync(fixture.log, 'utf8')).toContain('pod install');
    });

    it('fails naming CocoaPods when pod is not on PATH', () => {
      const fixture = iosFixture('no-pod');
      fs.writeFileSync(path.join(fixture.dir, 'Podfile'), "platform :ios, '17.0'\n");

      const result = provision(fixture, { pathPrefix: '/usr/bin:/bin' });

      expect(result.code).not.toBe(0);
      expect(result.stdout).toContain('CocoaPods');
    });

    it('skips generation when the worktree already has a project', () => {
      const fixture = iosFixture('tracked');
      fs.writeFileSync(path.join(fixture.dir, 'project.yml'), 'name: Fixture\n');
      // A real .xcodeproj carries an inner project.xcworkspace — that must not
      // change the answer either way.
      fs.mkdirSync(path.join(fixture.dir, 'Fixture.xcodeproj', 'project.xcworkspace'), {
        recursive: true,
      });
      stubGenerator(fixture.bin, 'xcodegen', fixture.log);

      const result = provision(fixture);

      expect(result.code).toBe(0);
      expect(fs.existsSync(fixture.log)).toBe(false);
    });

    it('regenerates when HARNESS_XCODE_PROJECT names a file this worktree lacks', () => {
      const fixture = iosFixture('adapt-time');
      fs.writeFileSync(path.join(fixture.dir, 'project.yml'), 'name: Fixture\n');
      stubGenerator(fixture.bin, 'xcodegen', fixture.log, path.join(fixture.dir, 'Fixture.xcodeproj'));

      const result = run(
        `PATH="${fixture.bin}:/usr/bin:/bin" HARNESS_ECOSYSTEM=ios ` +
          `HARNESS_XCODE_PROJECT=Fixture.xcodeproj ` +
          `HAR_WORK_DIR="${fixture.dir}" HAR_ENV_FILE="${fixture.envFile}" HAR_AGENT_ID=1 ` +
          `bash "${scriptPath}" 2>&1`,
      );

      expect(result.code).toBe(0);
      expect(fs.readFileSync(fixture.log, 'utf8')).toContain('xcodegen generate');
    });

    it('lets an explicit HARNESS_INSTALL_CMD own provisioning', () => {
      const fixture = iosFixture('install-cmd');
      fs.writeFileSync(path.join(fixture.dir, 'project.yml'), 'name: Fixture\n');
      stubGenerator(fixture.bin, 'xcodegen', fixture.log);

      const result = provision(fixture, { installCmd: 'true' });

      expect(result.code).toBe(0);
      expect(fs.existsSync(fixture.log)).toBe(false);
    });

    it('fails the launch when HARNESS_INSTALL_CMD fails', () => {
      const fixture = iosFixture('install-cmd-fail');
      fs.writeFileSync(path.join(fixture.dir, 'project.yml'), 'name: Fixture\n');
      stubGenerator(fixture.bin, 'xcodegen', fixture.log);

      const result = provision(fixture, { installCmd: 'false' });

      expect(result.code).not.toBe(0);
      expect(fs.existsSync(fixture.log)).toBe(false);
    });

    it('records XCODEBUILD_BIN with no generator manifest present', () => {
      const fixture = iosFixture('bare');

      const result = provision(fixture);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('no generator manifest');
      expect(fs.readFileSync(fixture.envFile, 'utf8')).toContain('XCODEBUILD_BIN=');
    });
  });
});
