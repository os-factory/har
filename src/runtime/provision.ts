import * as fs from 'fs';
import * as path from 'path';
import { realSystemOps, SystemOps } from './exec';
import {
  declaredNodePackageManager,
  HarnessEnv,
  nodeInstall,
  nodePackageManager,
  pkgExec,
} from './node-pm';

/**
 * Package-side toolchain provisioning — TS home of
 * runtime-bundles/shared-kernel/provision-toolchain.sh (#234).
 *
 * Provisions the project toolchain for a freshly launched slot and appends
 * resolved paths to .env.agent.<id>. Observable behavior mirrors the script:
 * same ecosystem detection order, same install commands, same env keys and
 * log lines. Values in the env file are shell-quoted so `source` keeps
 * working (single-quote style instead of printf %q — parse-identical).
 */

export type Ecosystem =
  | 'node'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'ruby'
  | 'ios'
  | 'custom'
  | 'none';

export interface ProvisionOptions {
  /** Directory the session's code lives in (worktree, or repo root). */
  workDir: string;
  /** Absolute path of .env.agent.<id> — resolved paths are appended here. */
  envFile: string;
  /** Worktree root when the project lives in a monorepo subdirectory. */
  worktreeDir?: string;
  /** `git rev-parse --show-prefix` of the project inside the worktree. */
  relPrefix?: string;
  /** Slot id, for log prefixes only. */
  agentId?: number | string;
  /** Parsed harness.env values (HARNESS_ECOSYSTEM, HARNESS_INSTALL_CMD, …). */
  harnessEnv?: HarnessEnv;
  ops?: SystemOps;
  /** Log sink; defaults to stderr with the agent prefix the script used. */
  log?: (message: string) => void;
}

export class ProvisionError extends Error {}

/** Shell-quote a value so `source .env.agent.<id>` reads it intact. */
export function quoteEnvValue(value: string): string {
  if (value === '') return "''";
  if (/^[A-Za-z0-9_.,:=+@%/-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Skip provisioning when deps were already installed (resume after a failed
 * launch step). Mirror of har_toolchain_ready in agent-slot.sh.
 */
export function toolchainReady(workDir: string): boolean {
  if (
    fs.existsSync(path.join(workDir, 'package.json')) &&
    fs.existsSync(path.join(workDir, 'node_modules'))
  ) {
    return true;
  }
  return fs.existsSync(path.join(workDir, '.har', 'venv'));
}

/** Ecosystem for a work dir: explicit HARNESS_ECOSYSTEM wins, else manifest detection. */
export function detectEcosystem(dir: string, env: HarnessEnv = {}): Ecosystem {
  const configured = env.HARNESS_ECOSYSTEM ?? 'auto';
  if (configured && configured !== 'auto') return configured as Ecosystem;

  const has = (name: string) => fs.existsSync(path.join(dir, name));
  if (has('package.json')) return 'node';
  if (has('pyproject.toml') || has('setup.py') || has('setup.cfg') || has('requirements.txt') || has('Pipfile')) {
    return 'python';
  }
  if (has('go.mod')) return 'go';
  if (has('Cargo.toml')) return 'rust';
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) return 'java';
  if (has('Gemfile')) return 'ruby';
  if (env.HARNESS_XCODE_SCHEME || env.HARNESS_XCODE_PROJECT || env.HARNESS_XCODE_WORKSPACE) {
    return 'ios';
  }
  return 'none';
}

// ── Python interpreter helpers ────────────────────────────────────────────────
// Resolve the project Python (requires-python, .python-version, uv) instead of
// blindly using PATH python3. Exported for unit tests.

export function pythonVersionToSortable(version: string): number {
  const v = version.replace(/^python/, '').replace(/^v/, '');
  const [major = 0, minor = 0, patch = 0] = v.split('.').map((p) => parseInt(p, 10) || 0);
  return major * 1_000_000 + minor * 1_000 + patch;
}

export function pythonVersionGe(a: string, b: string): boolean {
  return pythonVersionToSortable(a) >= pythonVersionToSortable(b);
}

/** Minimum X.Y from a requires-python spec (">=3.10,<4" → "3.10"), or null. */
export function pythonRequiresMinimum(spec: string | null | undefined): string | null {
  if (!spec) return null;
  for (const re of [/>=\s*(\d+\.\d+)/, /~=\s*(\d+\.\d+)/, /==\s*(\d+\.\d+)/]) {
    const m = spec.match(re);
    if (m) return m[1];
  }
  const bare = spec.match(/^(\d+\.\d+)/);
  return bare ? bare[1] : null;
}

function pythonReadDotVersion(dir: string): string | null {
  const file = path.join(dir, '.python-version');
  if (!fs.existsSync(file)) return null;
  const first = fs.readFileSync(file, 'utf8').split('\n')[0].replace(/\s/g, '');
  return first || null;
}

function pythonReadRequiresSpec(dir: string): string | null {
  const pyproject = path.join(dir, 'pyproject.toml');
  if (fs.existsSync(pyproject)) {
    for (const line of fs.readFileSync(pyproject, 'utf8').split('\n')) {
      const m = line.match(/^\s*requires-python\s*=\s*"([^"]*)"/);
      if (m) return m[1];
    }
  }
  const setupCfg = path.join(dir, 'setup.cfg');
  if (fs.existsSync(setupCfg)) {
    let inOptions = false;
    for (const line of fs.readFileSync(setupCfg, 'utf8').split('\n')) {
      if (/^\[options\]/.test(line)) {
        inOptions = true;
        continue;
      }
      if (/^\[/.test(line)) inOptions = false;
      if (!inOptions) continue;
      const m = line.match(/^python_requires\s*=\s*(.*)/);
      if (m) return m[1].replace(/[ "]/g, '');
    }
  }
  return null;
}

/** Highest of requires-python minimum and .python-version (X.Y), or null. */
export function pythonProjectMinimum(dir: string): string | null {
  const reqMin = pythonRequiresMinimum(pythonReadRequiresSpec(dir));
  let dotVer = pythonReadDotVersion(dir);
  if (dotVer) {
    const m = dotVer.replace(/^v/, '').match(/^(\d+\.\d+)/);
    dotVer = m ? m[1] : null;
  }
  if (reqMin && dotVer) return pythonVersionGe(dotVer, reqMin) ? dotVer : reqMin;
  return reqMin ?? dotVer;
}

function pythonIsUvProject(dir: string): boolean {
  if (fs.existsSync(path.join(dir, 'uv.lock'))) return true;
  const pyproject = path.join(dir, 'pyproject.toml');
  if (!fs.existsSync(pyproject)) return false;
  return /^\[tool\.uv\]/m.test(fs.readFileSync(pyproject, 'utf8'));
}

// ── iOS Xcode project helpers ─────────────────────────────────────────────────
// Tuist, XcodeGen and CocoaPods treat the .xcodeproj / .xcworkspace as a build
// product rather than a tracked file, so a fresh worktree has nothing for
// xcodebuild to open. Generate it during provisioning — and fail naming the
// missing generator instead of letting xcodebuild report "scheme not found".

/** First project file matching a suffix within depth 2, skipping dotfiles, *.xcodeproj internals and Pods/. */
export function iosFindProjectFile(dir: string, suffix: string): string | null {
  const matches: string[] = [];
  const walk = (rel: string, depth: number) => {
    const abs = rel ? path.join(dir, rel) : dir;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.')) continue;
      if (childRel.split('/').includes('Pods')) continue;
      if (rel.endsWith('.xcodeproj')) continue;
      if (entry.name.endsWith(suffix)) matches.push(childRel);
      if (entry.isDirectory() && depth < 2 && !entry.name.endsWith('.xcodeproj')) {
        walk(childRel, depth + 1);
      }
    }
  };
  walk('', 1);
  matches.sort();
  return matches[0] ?? null;
}

function iosHasProject(dir: string, env: HarnessEnv): boolean {
  const workspace = env.HARNESS_XCODE_WORKSPACE;
  const project = env.HARNESS_XCODE_PROJECT;
  if (workspace || project) {
    if (workspace && fs.existsSync(path.join(dir, workspace))) return true;
    if (project && fs.existsSync(path.join(dir, project))) return true;
    return false;
  }
  if (iosFindProjectFile(dir, '.xcworkspace')) return true;
  return iosFindProjectFile(dir, '.xcodeproj') !== null;
}

/** Generator this repo declares, or empty. A Podfile counts: `pod install` writes the .xcworkspace. */
export function iosProjectGenerator(dir: string): 'tuist' | 'xcodegen' | 'pod' | '' {
  const has = (name: string) => fs.existsSync(path.join(dir, name));
  if (has('Project.swift') || has('Workspace.swift')) return 'tuist';
  if (has('project.yml') || has('project.yaml')) return 'xcodegen';
  if (has('Podfile')) return 'pod';
  return '';
}

// ── Provisioner ───────────────────────────────────────────────────────────────

class Provisioner {
  private readonly workDir: string;
  private readonly envFile: string;
  private readonly worktreeDir: string;
  private readonly relPrefix: string;
  private readonly env: HarnessEnv;
  private readonly ops: SystemOps;
  private readonly logFn: (message: string) => void;

  constructor(options: ProvisionOptions) {
    this.workDir = options.workDir;
    this.envFile = options.envFile;
    this.worktreeDir = options.worktreeDir ?? '';
    this.relPrefix = options.relPrefix ?? '';
    this.env = options.harnessEnv ?? {};
    this.ops = options.ops ?? realSystemOps;
    const agentId = options.agentId;
    this.logFn =
      options.log ??
      ((message: string) => {
        const prefix =
          agentId !== undefined && agentId !== ''
            ? `==> [agent-${agentId}] toolchain:`
            : '==> [provision-toolchain]';
        process.stderr.write(`${prefix} ${message}\n`);
      });
  }

  private log(message: string): void {
    this.logFn(message);
  }

  private appendEnv(key: string, value: string): void {
    fs.appendFileSync(this.envFile, `${key}=${quoteEnvValue(value)}\n`);
  }

  private appendPathPrefix(prefix: string): void {
    if (!prefix || !fs.existsSync(prefix)) return;
    this.appendEnv('PATH', `${prefix}:${process.env.PATH ?? ''}`);
  }

  /** Extra process env for subprocesses (venv activation is PATH + VIRTUAL_ENV). */
  private subEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { ...process.env, ...extra };
  }

  /** HARNESS_INSTALL_CMD override; true when it ran (a failure aborts provisioning). */
  private async runInstallCmd(dir: string, extraEnv: NodeJS.ProcessEnv = {}): Promise<boolean> {
    const cmd = this.env.HARNESS_INSTALL_CMD;
    if (!cmd) return false;
    this.log('Running HARNESS_INSTALL_CMD...');
    const result = await this.ops.runShell(cmd, {
      cwd: dir,
      stream: true,
      env: this.subEnv(extraEnv),
    });
    if (result.code !== 0) {
      throw new ProvisionError(`HARNESS_INSTALL_CMD exited with code ${result.code}`);
    }
    return true;
  }

  // ── node ──

  private async provisionNode(dir: string): Promise<void> {
    const declared = declaredNodePackageManager(dir, this.env, this.ops);
    const manager = nodePackageManager(dir, this.env, this.ops);

    if (declared && declared !== manager) {
      this.log(
        `Repo declares ${declared}, which is not on PATH — installing with ${manager} and leaving the lockfile untouched.`,
      );
    }

    if (!(await this.runInstallCmd(dir))) {
      this.log(`Installing Node dependencies with ${manager}...`);
      const code = await nodeInstall(dir, manager, declared, this.ops);
      if (code !== 0) {
        throw new ProvisionError(`${manager} install exited with code ${code}`);
      }
    }

    let nodeBin = 'node';
    const nodePath = this.ops.which('node');
    if (nodePath) {
      nodeBin = nodePath;
    } else if (manager === 'bun') {
      // bun-only machine: bun runs the `node -e` snippets verify relies on.
      nodeBin = this.ops.which('bun') ?? 'bun';
    }

    const npmBin = this.ops.which(manager) ?? manager;

    this.appendEnv('HARNESS_ECOSYSTEM', 'node');
    this.appendEnv('NODE_BIN', nodeBin);
    this.appendEnv('NPM_BIN', npmBin);
    this.appendEnv('HARNESS_NODE_PACKAGE_MANAGER', manager);
    this.appendEnv('HARNESS_PKG_EXEC', pkgExec(manager, this.env, this.ops));
    this.appendPathPrefix(path.join(dir, 'node_modules', '.bin'));
  }

  // ── python ──

  private async pythonVersionFromBin(bin: string): Promise<string | null> {
    return this.ops.capture(bin, ['-c', 'import sys; print(".".join(map(str, sys.version_info[:3])))']);
  }

  private async pythonUvFind(dir: string, request?: string | null): Promise<string | null> {
    if (!this.ops.which('uv')) return null;
    const args = request ? ['python', 'find', request] : ['python', 'find'];
    return this.ops.capture('uv', args, { cwd: dir });
  }

  private async pythonResolveInterpreter(dir: string, minimum: string | null): Promise<string | null> {
    const executable = (p: string | null): p is string => !!p && this.ops.which(p) !== null;

    if (pythonIsUvProject(dir)) {
      const found = await this.pythonUvFind(dir, minimum);
      if (executable(found)) return found;
    }

    if (fs.existsSync(path.join(dir, '.python-version'))) {
      const found = await this.pythonUvFind(dir, pythonReadDotVersion(dir));
      if (executable(found)) return found;
      if (this.ops.which('pyenv')) {
        const viaPyenv = await this.ops.capture('pyenv', ['which', 'python'], { cwd: dir });
        if (executable(viaPyenv)) return viaPyenv;
      }
    }

    if (minimum) {
      const found = await this.pythonUvFind(dir, minimum);
      if (executable(found)) return found;
    }

    // System python3 is the last resort even when older than the minimum —
    // the warning (not a hard failure) matches the script.
    return this.ops.which('python3');
  }

  private async pythonWarnIfBelowMinimum(bin: string, minimum: string | null): Promise<void> {
    if (!minimum) return;
    const actual = await this.pythonVersionFromBin(bin);
    if (actual && !pythonVersionGe(actual, minimum)) {
      this.log(
        `WARNING: resolved Python ${actual} is older than required ${minimum} (requires-python / .python-version)`,
      );
    }
  }

  private async pythonCreateVenv(dir: string, venvDir: string, interpreter: string): Promise<boolean> {
    const venvRel = venvDir.startsWith(`${dir}/`) ? venvDir.slice(dir.length + 1) : venvDir;
    if (pythonIsUvProject(dir) && this.ops.which('uv')) {
      this.log(`Creating Python venv with uv at ${venvRel}...`);
      const withPython = await this.ops.run('uv', ['venv', '--python', interpreter, venvDir], {
        cwd: dir,
        quietStderr: true,
      });
      if (withPython.code === 0) return true;
      const plain = await this.ops.run('uv', ['venv', venvDir], { cwd: dir, quietStderr: true });
      if (plain.code === 0) return true;
      this.log(`uv venv failed — falling back to ${interpreter} -m venv`);
    }
    this.log(`Creating Python venv at ${venvRel}...`);
    const result = await this.ops.run(interpreter, ['-m', 'venv', venvDir], { stream: true });
    return result.code === 0;
  }

  private async pythonInstallDepsWithUv(dir: string, venvDir: string): Promise<boolean> {
    if (!pythonIsUvProject(dir) || !this.ops.which('uv')) return false;
    this.log('Syncing Python dependencies with uv...');
    const scoped = await this.ops.run('uv', ['sync', '--quiet'], {
      cwd: dir,
      quietStderr: true,
      env: this.subEnv({ UV_PROJECT_ENVIRONMENT: venvDir }),
    });
    if (scoped.code === 0) return true;
    const plain = await this.ops.run('uv', ['sync', '--quiet'], { cwd: dir, quietStderr: true });
    if (plain.code === 0) return true;
    this.log('uv sync failed — falling back to pip');
    return false;
  }

  private async provisionPython(dir: string): Promise<void> {
    const venvRel = this.env.HARNESS_PYTHON_VENV_DIR || '.har/venv';
    const venvDir = path.join(dir, venvRel);
    const projectMin = pythonProjectMinimum(dir);
    const interpreter = await this.pythonResolveInterpreter(dir, projectMin);

    if (!interpreter || !this.ops.which(interpreter)) {
      this.log('No suitable Python interpreter found — skipping venv provisioning');
      this.appendEnv('HARNESS_ECOSYSTEM', 'python');
      this.appendEnv('PYTHON_BIN', this.env.PYTHON_BIN || process.env.PYTHON_BIN || 'python3');
      return;
    }

    await this.pythonWarnIfBelowMinimum(interpreter, projectMin);

    const venvPython = path.join(venvDir, 'bin', 'python');
    if (fs.existsSync(venvDir) && fs.existsSync(venvPython) && projectMin) {
      const venvVer = await this.pythonVersionFromBin(venvPython);
      if (venvVer && !pythonVersionGe(venvVer, projectMin)) {
        this.log(`Existing venv Python ${venvVer} is older than required ${projectMin} — recreating...`);
        fs.rmSync(venvDir, { recursive: true, force: true });
      }
    }

    if (!fs.existsSync(venvDir)) {
      if (!(await this.pythonCreateVenv(dir, venvDir, interpreter))) {
        fs.rmSync(venvDir, { recursive: true, force: true });
        this.log('venv creation failed (on Debian/Ubuntu install python3-venv) — using resolved interpreter');
        this.appendEnv('HARNESS_ECOSYSTEM', 'python');
        this.appendEnv('PYTHON_BIN', interpreter);
        return;
      }
    }

    if (!fs.existsSync(venvPython)) {
      this.log(`Python venv at ${venvRel} is missing or broken — using resolved interpreter`);
      this.appendEnv('HARNESS_ECOSYSTEM', 'python');
      this.appendEnv('PYTHON_BIN', interpreter);
      return;
    }

    let pythonBin = venvPython;
    await this.pythonWarnIfBelowMinimum(pythonBin, projectMin);

    // `source venv/bin/activate` equivalent for subprocesses.
    const activated: NodeJS.ProcessEnv = {
      VIRTUAL_ENV: venvDir,
      PATH: `${path.join(venvDir, 'bin')}:${process.env.PATH ?? ''}`,
    };

    if (!(await this.runInstallCmd(dir, activated))) {
      if (!(await this.pythonInstallDepsWithUv(dir, venvDir))) {
        this.log('Installing Python dependencies...');
        const pip = (args: string[], quiet: boolean) =>
          this.ops.run(path.join(venvDir, 'bin', 'pip'), args, {
            cwd: dir,
            quietStderr: quiet,
            stream: !quiet,
          });
        if (fs.existsSync(path.join(dir, 'pyproject.toml'))) {
          const dev = await pip(['install', '-q', '-e', '.[dev]'], true);
          if (dev.code !== 0) {
            const plain = await pip(['install', '-q', '-e', '.'], false);
            if (plain.code !== 0) throw new ProvisionError('pip install -e . failed');
          }
        } else if (fs.existsSync(path.join(dir, 'requirements.txt'))) {
          const result = await pip(['install', '-q', '-r', 'requirements.txt'], false);
          if (result.code !== 0) throw new ProvisionError('pip install -r requirements.txt failed');
        } else if (fs.existsSync(path.join(dir, 'setup.py')) || fs.existsSync(path.join(dir, 'setup.cfg'))) {
          const result = await pip(['install', '-q', '-e', '.'], false);
          if (result.code !== 0) throw new ProvisionError('pip install -e . failed');
        } else if (fs.existsSync(path.join(dir, 'Pipfile')) && this.ops.which('pipenv')) {
          const result = await this.ops.run('pipenv', ['install', '--dev'], {
            cwd: dir,
            stream: true,
            env: this.subEnv(activated),
          });
          if (result.code !== 0) throw new ProvisionError('pipenv install --dev failed');
          const py = await this.ops.capture('pipenv', ['--py'], { cwd: dir });
          if (py) pythonBin = py;
        }
      }
    }

    this.appendEnv('HARNESS_ECOSYSTEM', 'python');
    this.appendEnv('PYTHON_BIN', pythonBin);
    this.appendEnv('VIRTUAL_ENV', venvDir);
    this.appendPathPrefix(path.join(venvDir, 'bin'));
  }

  // ── go / rust / java / ruby ──

  private async provisionGo(dir: string): Promise<void> {
    if (!(await this.runInstallCmd(dir))) {
      if (this.ops.which('go')) {
        this.log('Downloading Go modules...');
        const result = await this.ops.run('go', ['mod', 'download'], { cwd: dir, stream: true });
        if (result.code !== 0) throw new ProvisionError('go mod download failed');
      } else {
        this.log('go not found on PATH — record paths only');
      }
    }
    this.appendEnv('HARNESS_ECOSYSTEM', 'go');
    this.appendEnv('GO_BIN', this.ops.which('go') ?? 'go');
    if (process.env.GOPATH) this.appendEnv('GOPATH', process.env.GOPATH);
    if (process.env.GOROOT) this.appendEnv('GOROOT', process.env.GOROOT);
  }

  private async provisionRust(dir: string): Promise<void> {
    if (!(await this.runInstallCmd(dir))) {
      if (this.ops.which('cargo')) {
        this.log('Fetching Rust dependencies...');
        const result = await this.ops.run('cargo', ['fetch'], { cwd: dir, stream: true });
        if (result.code !== 0) throw new ProvisionError('cargo fetch failed');
      } else {
        this.log('cargo not found on PATH — record paths only');
      }
    }
    this.appendEnv('HARNESS_ECOSYSTEM', 'rust');
    this.appendEnv('CARGO_BIN', this.ops.which('cargo') ?? 'cargo');
    this.appendEnv('RUSTC_BIN', this.ops.which('rustc') ?? 'rustc');
  }

  private async provisionJava(dir: string): Promise<void> {
    try {
      await this.runInstallCmd(dir);
    } catch {
      // `run_install_cmd "$dir" || true` — a failing override does not abort java provisioning.
    }
    this.appendEnv('HARNESS_ECOSYSTEM', 'java');
    if (process.env.JAVA_HOME) {
      this.appendEnv('JAVA_HOME', process.env.JAVA_HOME);
      this.appendPathPrefix(path.join(process.env.JAVA_HOME, 'bin'));
    }
    const mvn = this.ops.which('mvn');
    if (mvn) {
      this.appendEnv('MVN_BIN', mvn);
    } else if (fs.existsSync(path.join(dir, 'gradlew'))) {
      this.appendEnv('GRADLE_BIN', path.join(dir, 'gradlew'));
    } else {
      const gradle = this.ops.which('gradle');
      if (gradle) this.appendEnv('GRADLE_BIN', gradle);
    }
  }

  private async provisionRuby(dir: string): Promise<void> {
    if (!(await this.runInstallCmd(dir))) {
      if (this.ops.which('bundle')) {
        this.log('Installing Ruby gems...');
        const result = await this.ops.run('bundle', ['install', '--quiet'], { cwd: dir, stream: true });
        if (result.code !== 0) throw new ProvisionError('bundle install failed');
      } else {
        this.log('bundle not found on PATH — record paths only');
      }
    }
    this.appendEnv('HARNESS_ECOSYSTEM', 'ruby');
    this.appendEnv('RUBY_BIN', this.ops.which('ruby') ?? 'ruby');
    this.appendEnv('BUNDLE_BIN', this.ops.which('bundle') ?? 'bundle');
    this.appendPathPrefix(path.join(dir, 'vendor', 'bundle', 'bin'));
  }

  // ── ios ──

  private async iosGenerateProject(dir: string): Promise<void> {
    if (iosHasProject(dir, this.env)) return;

    const generator = iosProjectGenerator(dir);
    if (!generator) {
      this.log(
        'No .xcodeproj/.xcworkspace found and no generator manifest (Project.swift, project.yml, Podfile) — set HARNESS_XCODE_PROJECT/HARNESS_XCODE_WORKSPACE or HARNESS_INSTALL_CMD in harness.env',
      );
      return;
    }

    if (!this.ops.which(generator)) {
      const label = generator === 'pod' ? 'CocoaPods (pod)' : generator;
      this.log(`ERROR: this repo generates its Xcode project with ${label}, which is not on PATH.`);
      this.log(`       Install ${label}, or set HARNESS_INSTALL_CMD in harness.env to provision the project another way.`);
      throw new ProvisionError(`Xcode project generator not on PATH: ${generator}`);
    }

    if (generator === 'tuist') {
      this.log('Generating the Xcode project with tuist...');
      const noOpen = await this.ops.run('tuist', ['generate', '--no-open'], { cwd: dir, stream: true });
      if (noOpen.code !== 0) {
        this.log('tuist generate --no-open failed — retrying without the flag');
        const plain = await this.ops.run('tuist', ['generate'], { cwd: dir, stream: true });
        if (plain.code !== 0) throw new ProvisionError('tuist generate failed');
      }
    } else if (generator === 'xcodegen') {
      this.log('Generating the Xcode project with xcodegen...');
      const result = await this.ops.run('xcodegen', ['generate'], { cwd: dir, stream: true });
      if (result.code !== 0) throw new ProvisionError('xcodegen generate failed');
    }
    // pod: iosPodInstall writes the workspace right after this.
  }

  private async iosPodInstall(dir: string): Promise<void> {
    if (!fs.existsSync(path.join(dir, 'Podfile'))) return;
    if (fs.existsSync(path.join(dir, 'Pods'))) return;

    if (!this.ops.which('pod')) {
      this.log('ERROR: this repo uses CocoaPods (Podfile, no Pods/) and pod is not on PATH.');
      this.log('       Install CocoaPods, or set HARNESS_INSTALL_CMD in harness.env to provision the project another way.');
      throw new ProvisionError('CocoaPods (pod) not on PATH');
    }

    this.log('Installing CocoaPods dependencies...');
    const result = await this.ops.run('pod', ['install'], { cwd: dir, stream: true });
    if (result.code !== 0) throw new ProvisionError('pod install failed');
  }

  private async provisionIos(dir: string): Promise<void> {
    // An explicit HARNESS_INSTALL_CMD owns provisioning outright: the default
    // generators stay out of the way, and a failing override fails the launch
    // rather than being papered over.
    if (this.env.HARNESS_INSTALL_CMD) {
      await this.runInstallCmd(dir);
    } else {
      await this.iosGenerateProject(dir);
      await this.iosPodInstall(dir);
    }

    this.appendEnv('HARNESS_ECOSYSTEM', 'ios');
    this.appendEnv('XCODEBUILD_BIN', this.ops.which('xcodebuild') ?? 'xcodebuild');
    if (this.env.HARNESS_XCODE_SCHEME) this.appendEnv('HARNESS_XCODE_SCHEME', this.env.HARNESS_XCODE_SCHEME);
    // The simulator is not recorded here: launch writes the device reserved for
    // this slot, and harness.env already carries the shared one.
    if (this.env.HARNESS_BUNDLE_ID) this.appendEnv('HARNESS_BUNDLE_ID', this.env.HARNESS_BUNDLE_ID);
    if (process.env.DEVELOPER_DIR) this.appendEnv('DEVELOPER_DIR', process.env.DEVELOPER_DIR);
  }

  // ── monorepo root ──

  private async provisionMonorepoRoot(): Promise<void> {
    if (!this.relPrefix || !this.worktreeDir) return;
    if (!fs.existsSync(path.join(this.worktreeDir, 'package.json'))) return;
    if (fs.existsSync(path.join(this.worktreeDir, 'node_modules'))) return;
    const manager = nodePackageManager(this.worktreeDir, this.env, this.ops);
    this.log(`Installing monorepo root dependencies in ${this.worktreeDir} with ${manager}...`);
    const code = await nodeInstall(
      this.worktreeDir,
      manager,
      declaredNodePackageManager(this.worktreeDir, this.env, this.ops),
      this.ops,
    );
    if (code !== 0) throw new ProvisionError(`monorepo root ${manager} install exited with code ${code}`);
  }

  async provision(): Promise<Ecosystem> {
    this.appendEnv('HARNESS_TOOLCHAIN_PROVISIONED', 'true');

    const dir = this.workDir;
    const ecosystem = detectEcosystem(dir, this.env);
    this.log(`Toolchain ecosystem: ${ecosystem} (work dir: ${dir})`);

    let recorded: Ecosystem = ecosystem;
    switch (ecosystem) {
      case 'node':
        await this.provisionNode(dir);
        break;
      case 'python':
        await this.provisionPython(dir);
        break;
      case 'go':
        await this.provisionGo(dir);
        break;
      case 'rust':
        await this.provisionRust(dir);
        break;
      case 'java':
        await this.provisionJava(dir);
        break;
      case 'ruby':
        await this.provisionRuby(dir);
        break;
      case 'ios':
        await this.provisionIos(dir);
        break;
      default:
        if (await this.runInstallCmd(dir)) {
          this.appendEnv('HARNESS_ECOSYSTEM', 'custom');
          recorded = 'custom';
        } else {
          this.log('No ecosystem manifest detected — set HARNESS_ECOSYSTEM or HARNESS_INSTALL_CMD in harness.env');
          this.appendEnv('HARNESS_ECOSYSTEM', 'none');
          recorded = 'none';
        }
        break;
    }

    await this.provisionMonorepoRoot();
    return recorded;
  }
}

/**
 * Provision the project toolchain for a launched slot and append resolved
 * paths to the agent env file. Returns the ecosystem that was provisioned.
 * Throws ProvisionError on install/generation failures (the script's `set -e`).
 */
export async function provisionToolchain(options: ProvisionOptions): Promise<Ecosystem> {
  return new Provisioner(options).provision();
}
