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

  it('ships the same provision-toolchain.sh in every profile', () => {
    const contents = PROFILES.map((profile) =>
      fs.readFileSync(path.join(resolveTemplatesDir(), profile, 'provision-toolchain.sh'), 'utf8'),
    );
    // The three copies are edited together on purpose — a divergence here means one
    // profile silently lost a toolchain fix.
    expect(contents[1]).toBe(contents[0]);
    expect(contents[2]).toBe(contents[0]);
  });

  describe('iOS generated-project provisioning', () => {
    const IOS_SCRIPT = path.join(
      resolveTemplatesDir(),
      'har-boilerplate-ios',
      'provision-toolchain.sh',
    );
    // Stock PATH only: a real pod/tuist installed on the developer's machine must not
    // decide the outcome of the "tool is missing" cases.
    const BARE_PATH = '/usr/bin:/bin';

    function makeWorkDir(prefix: string): { dir: string; envFile: string } {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      const envFile = path.join(dir, '.env.agent.1');
      fs.writeFileSync(envFile, `AGENT_ID=1\nREPO_ROOT=${dir}\n`);
      return { dir, envFile };
    }

    function fakeBin(dir: string, name: string, marker: string): string {
      const binDir = path.join(dir, 'fakebin');
      fs.mkdirSync(binDir, { recursive: true });
      const bin = path.join(binDir, name);
      fs.writeFileSync(bin, `#!/usr/bin/env bash\necho "$@" > "${marker}"\n`);
      fs.chmodSync(bin, 0o755);
      return binDir;
    }

    function provision(dir: string, envFile: string, pathValue: string, extraEnv = '') {
      return run(
        `PATH="${pathValue}" HARNESS_ECOSYSTEM=ios ${extraEnv} ` +
          `HAR_WORK_DIR="${dir}" HAR_ENV_FILE="${envFile}" HAR_AGENT_ID=1 ` +
          `bash "${IOS_SCRIPT}"`,
      );
    }

    it('fails with a named cause when a Podfile has no CocoaPods available', () => {
      const { dir, envFile } = makeWorkDir('har-pt-pods-missing-');
      fs.writeFileSync(path.join(dir, 'Podfile'), "platform :ios, '17.0'\n");

      const result = provision(dir, envFile, BARE_PATH);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('CocoaPods');
      expect(result.stderr).toContain('HARNESS_INSTALL_CMD');
    });

    it('runs pod install when a Podfile has no Pods directory', () => {
      const { dir, envFile } = makeWorkDir('har-pt-pods-run-');
      fs.writeFileSync(path.join(dir, 'Podfile'), "platform :ios, '17.0'\n");
      const marker = path.join(dir, 'pod-ran');
      const binDir = fakeBin(dir, 'pod', marker);

      const result = provision(dir, envFile, `${binDir}:${BARE_PATH}`);

      expect(result.code).toBe(0);
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe('install');
    });

    it('skips pod install when Pods are already checked out', () => {
      const { dir, envFile } = makeWorkDir('har-pt-pods-present-');
      fs.writeFileSync(path.join(dir, 'Podfile'), "platform :ios, '17.0'\n");
      fs.mkdirSync(path.join(dir, 'Pods'));
      const marker = path.join(dir, 'pod-ran');
      const binDir = fakeBin(dir, 'pod', marker);

      const result = provision(dir, envFile, `${binDir}:${BARE_PATH}`);

      expect(result.code).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('generates the project with Tuist when only Project.swift is tracked', () => {
      const { dir, envFile } = makeWorkDir('har-pt-tuist-');
      fs.writeFileSync(path.join(dir, 'Project.swift'), 'let project = Project()\n');
      const marker = path.join(dir, 'tuist-ran');
      const binDir = fakeBin(dir, 'tuist', marker);

      const result = provision(dir, envFile, `${binDir}:${BARE_PATH}`);

      expect(result.code).toBe(0);
      expect(fs.readFileSync(marker, 'utf8').trim()).toBe('generate --no-open');
    });

    it('fails with a named cause when project.yml has no XcodeGen available', () => {
      const { dir, envFile } = makeWorkDir('har-pt-xcodegen-missing-');
      fs.writeFileSync(path.join(dir, 'project.yml'), 'name: MyApp\n');

      const result = provision(dir, envFile, BARE_PATH);

      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('XcodeGen');
    });

    it('leaves generation alone when HARNESS_INSTALL_CMD owns provisioning', () => {
      const { dir, envFile } = makeWorkDir('har-pt-installcmd-');
      fs.writeFileSync(path.join(dir, 'Podfile'), "platform :ios, '17.0'\n");
      const marker = path.join(dir, 'pod-ran');
      const binDir = fakeBin(dir, 'pod', marker);

      const result = provision(
        dir,
        envFile,
        `${binDir}:${BARE_PATH}`,
        `HARNESS_INSTALL_CMD="true"`,
      );

      expect(result.code).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('fails loudly instead of falling back when HARNESS_INSTALL_CMD fails', () => {
      const { dir, envFile } = makeWorkDir('har-pt-installcmd-fail-');
      fs.writeFileSync(path.join(dir, 'Podfile'), "platform :ios, '17.0'\n");
      const marker = path.join(dir, 'pod-ran');
      const binDir = fakeBin(dir, 'pod', marker);

      const result = provision(
        dir,
        envFile,
        `${binDir}:${BARE_PATH}`,
        `HARNESS_INSTALL_CMD="false"`,
      );

      // run_install_cmd returns 1 both for "not configured" and "configured but
      // failed"; dispatching on that status would silently run the generators the
      // user overrode and hide the failure behind them.
      expect(result.code).not.toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('finds an existing project under a path containing a space', () => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'har-pt-space-'));
      const dir = path.join(parent, 'My Proj');
      fs.mkdirSync(path.join(dir, 'App.xcodeproj'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'Project.swift'), 'let project = Project()\n');
      const envFile = path.join(dir, '.env.agent.1');
      fs.writeFileSync(envFile, `AGENT_ID=1\nREPO_ROOT=${dir}\n`);
      const marker = path.join(dir, 'tuist-ran');
      const binDir = fakeBin(dir, 'tuist', marker);

      const result = provision(dir, envFile, `${binDir}:${BARE_PATH}`);

      // The glob must survive the space: regenerating over an existing project
      // would overwrite local project state on every launch.
      expect(result.code).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    });

    it('skips generation when the project is already present', () => {
      const { dir, envFile } = makeWorkDir('har-pt-generated-');
      fs.writeFileSync(path.join(dir, 'Project.swift'), 'let project = Project()\n');
      fs.mkdirSync(path.join(dir, 'MyApp.xcodeproj'), { recursive: true });
      const marker = path.join(dir, 'tuist-ran');
      const binDir = fakeBin(dir, 'tuist', marker);

      const result = provision(dir, envFile, `${binDir}:${BARE_PATH}`);

      expect(result.code).toBe(0);
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  describe('iOS verify.sh target resolution', () => {
    /** Lift one bash function out of a script so it can be exercised on its own. */
    function extractShellFunction(scriptPath: string, name: string): string {
      const content = fs.readFileSync(scriptPath, 'utf8');
      const start = content.indexOf(`${name}() {`);
      if (start < 0) throw new Error(`function ${name} not found in ${scriptPath}`);
      let depth = 0;
      let i = content.indexOf('{', start);
      for (; i < content.length; i++) {
        if (content[i] === '{') depth++;
        else if (content[i] === '}') {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      return content.slice(start, i);
    }

    function resolveTargets(workDir: string): string {
      const verifyPath = path.join(resolveTemplatesDir(), 'har-boilerplate-ios', 'verify.sh');
      const fn = extractShellFunction(verifyPath, 'xc_target_flags');
      const script = path.join(workDir, 'probe.sh');
      fs.writeFileSync(script, `set -uo pipefail\nWORK_DIR="${workDir}"\n${fn}\nxc_target_flags\n`);
      const result = run(`bash "${script}"`);
      expect(result.code).toBe(0);
      return result.stdout.trim();
    }

    it('ignores the project.xcworkspace nested inside every .xcodeproj', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-xc-inner-'));
      // Xcode puts this inside every project bundle; picking it shadows the real target.
      fs.mkdirSync(path.join(dir, 'MyApp.xcodeproj', 'project.xcworkspace'), { recursive: true });

      expect(resolveTargets(dir)).toBe(`-project ${dir}/MyApp.xcodeproj`);
    });

    it('still prefers a real workspace sitting next to the project', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-xc-real-'));
      fs.mkdirSync(path.join(dir, 'MyApp.xcodeproj', 'project.xcworkspace'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'MyApp.xcworkspace'), { recursive: true });

      expect(resolveTargets(dir)).toBe(`-workspace ${dir}/MyApp.xcworkspace`);
    });

    it('ignores Pods.xcodeproj generated by CocoaPods', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-xc-pods-'));
      fs.mkdirSync(path.join(dir, 'Pods', 'Pods.xcodeproj'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'MyApp.xcodeproj'), { recursive: true });

      expect(resolveTargets(dir)).toBe(`-project ${dir}/MyApp.xcodeproj`);
    });
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
