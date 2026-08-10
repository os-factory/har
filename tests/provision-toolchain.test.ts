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
