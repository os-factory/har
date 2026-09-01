import { execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AGENT_ENV_TEMPLATE_VARS,
  appendSessionTelemetry,
  generateAgentEnvFile,
  substituteEnvTemplate,
} from '../src/runtime/agent-env';

const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const VALUES = {
  AGENT_ID: 2,
  API_PORT: 8020,
  FE_PORT: 3020,
  DEBUG_PORT: 9220,
  DB_PORT: 15432,
  MINIO_PORT: 19000,
  BROWSER_PORT: 13001,
  REPO_ROOT: '/home/user/worktrees/session',
} as const;

function envsubstAvailable(): boolean {
  try {
    execSync('command -v envsubst', { stdio: 'ignore', shell: '/bin/bash' });
    return true;
  } catch {
    return false;
  }
}

/** Runs the real envsubst with the exact SHELL-FORMAT list launch.sh uses. */
function runEnvsubst(template: string): string {
  const shellFormat = AGENT_ENV_TEMPLATE_VARS.map((v) => `\${${v}}`).join(' ');
  return execFileSync('envsubst', [shellFormat], {
    input: template,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...Object.fromEntries(Object.entries(VALUES).map(([k, v]) => [k, String(v)])),
    },
  });
}

describe('substituteEnvTemplate', () => {
  it('substitutes braced and bare forms of the listed vars only', () => {
    const template = [
      'AGENT_ID=${AGENT_ID}',
      'PORT=$API_PORT',
      'DATABASE_URL=postgresql://postgres:password@localhost:${DB_PORT}/agent_${AGENT_ID}',
      'UNLISTED=${HOME} and $PATH stay put',
      'NOT_A_VAR=$$ and $1 and ${} stay put',
    ].join('\n');

    expect(substituteEnvTemplate(template, VALUES)).toBe(
      [
        'AGENT_ID=2',
        'PORT=8020',
        'DATABASE_URL=postgresql://postgres:password@localhost:15432/agent_2',
        'UNLISTED=${HOME} and $PATH stay put',
        'NOT_A_VAR=$$ and $1 and ${} stay put',
      ].join('\n'),
    );
  });

  it('replaces missing values with the empty string like envsubst', () => {
    expect(substituteEnvTemplate('x=${MINIO_PORT}y', {})).toBe('x=y');
  });

  it('does not substitute longer identifiers sharing a listed prefix', () => {
    expect(substituteEnvTemplate('a=$API_PORT_EXTRA b=${API_PORTX}', VALUES)).toBe(
      'a=$API_PORT_EXTRA b=${API_PORTX}',
    );
  });

  it('is byte-identical to real envsubst on the pm2-runtime template', () => {
    if (!envsubstAvailable()) {
      console.warn('envsubst unavailable — skipping byte-compat comparison');
      return;
    }
    const template = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'templates', 'runtime-bundles', 'pm2-runtime', 'env.template'),
      'utf8',
    );
    expect(substituteEnvTemplate(template, VALUES)).toBe(runEnvsubst(template));
  });

  it('is byte-identical to real envsubst on adversarial input', () => {
    if (!envsubstAvailable()) return;
    const template =
      'plain $FE_PORT ${FE_PORT} $FE_PORTS ${AGENT_ID}suffix $ lone\n' +
      'tail$DB_PORT ${REPO_ROOT}/x $NOPE ${ALSO_NOPE} _${API_PORT}_\n';
    expect(substituteEnvTemplate(template, VALUES)).toBe(runEnvsubst(template));
  });
});

describe('generateAgentEnvFile', () => {
  it('returns false and writes nothing when the template is absent', () => {
    const dir = tmpDir('har-agent-env-');
    const envFile = path.join(dir, '.env.agent.2');
    expect(
      generateAgentEnvFile({
        harnessDir: path.join(dir, '.har'),
        envFile,
        values: {
          agentId: 2,
          apiPort: 8020,
          fePort: 3020,
          debugPort: 9220,
          dbPort: 15432,
          minioPort: 19000,
          browserPort: 13001,
          repoRoot: dir,
        },
      }),
    ).toBe(false);
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it('renders env.template into the env file', () => {
    const dir = tmpDir('har-agent-env-');
    const harDir = path.join(dir, '.har');
    fs.mkdirSync(harDir, { recursive: true });
    fs.writeFileSync(
      path.join(harDir, 'env.template'),
      'AGENT_ID=${AGENT_ID}\nPORT=${API_PORT}\nROOT=${REPO_ROOT}\nKEEP=${SECRET}\n',
    );
    const envFile = path.join(dir, 'wt', '.env.agent.3');
    expect(
      generateAgentEnvFile({
        harnessDir: harDir,
        envFile,
        values: {
          agentId: 3,
          apiPort: 8030,
          fePort: 3030,
          debugPort: 9230,
          dbPort: 15432,
          minioPort: 19000,
          browserPort: 13001,
          repoRoot: path.join(dir, 'wt'),
        },
      }),
    ).toBe(true);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(
      `AGENT_ID=3\nPORT=8030\nROOT=${path.join(dir, 'wt')}\nKEEP=\${SECRET}\n`,
    );
  });
});

describe('appendSessionTelemetry', () => {
  it('appends the attribution block using explicit session details', () => {
    const dir = tmpDir('har-telemetry-');
    fs.mkdirSync(path.join(dir, '.har'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.har', 'manifest.json'),
      JSON.stringify({ version: '1', generatorVersion: '0.1.0', profile: 'cli' }),
    );
    const envFile = path.join(dir, '.env.agent.1');
    fs.writeFileSync(envFile, 'AGENT_ID=1\n');

    const written = appendSessionTelemetry({
      agentId: 1,
      repoPath: dir,
      envFile,
      workDir: dir,
      branch: 'main-ab12-har-agent-1-xy9z',
      suffix: 'xy9z',
      workUnitId: '234',
    });

    expect(written).toBe(envFile);
    const contents = fs.readFileSync(envFile, 'utf8');
    expect(contents).toContain('AGENT_ID=1');
    expect(contents).toContain('# HAR session attribution (generated)');
    expect(contents).toContain('HAR_SESSION_KEY=main-ab12-har-agent-1-xy9z');
    expect(contents).toContain('HAR_WORK_UNIT_ID=234');
    expect(contents).toContain('har.branch=main-ab12-har-agent-1-xy9z');
    expect(contents).toContain('# end HAR telemetry');
  });

  it('is idempotent — re-running replaces the block instead of stacking it', () => {
    const dir = tmpDir('har-telemetry-');
    fs.mkdirSync(path.join(dir, '.har'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, '.har', 'manifest.json'),
      JSON.stringify({ version: '1', generatorVersion: '0.1.0', profile: 'cli' }),
    );
    const envFile = path.join(dir, '.env.agent.2');
    fs.writeFileSync(envFile, 'AGENT_ID=2\n');

    appendSessionTelemetry({ agentId: 2, repoPath: dir, envFile, workDir: dir, branch: 'b1' });
    appendSessionTelemetry({ agentId: 2, repoPath: dir, envFile, workDir: dir, branch: 'b2' });

    const contents = fs.readFileSync(envFile, 'utf8');
    expect(contents.match(/# HAR session attribution \(generated\)/g)).toHaveLength(1);
    expect(contents).toContain('HAR_SESSION_KEY=b2');
    expect(contents).not.toContain('HAR_SESSION_KEY=b1');
  });
});
