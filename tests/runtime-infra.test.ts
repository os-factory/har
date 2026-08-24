import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ExecFn } from '../src/runtime/exec';
import {
  cloneAgentDatabase,
  composeServiceRunning,
  dropAgentDatabase,
  ensureMinioBucket,
  infraEnabled,
  infraPortDefault,
  infraPortLane,
  readInfraState,
  removeMinioBucket,
  resolveInfraPort,
  runPg,
  setupInfra,
  writeInfraState,
} from '../src/runtime/infra';

const PORTS = {
  AGENT_DB_PORT: 15432,
  AGENT_MINIO_PORT: 19000,
  AGENT_MINIO_CONSOLE_PORT: 19050,
  AGENT_BROWSER_PORT: 13001,
  AGENT_MAILPIT_WEB_PORT: 18025,
  AGENT_MAILPIT_SMTP_PORT: 11025,
};

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'har-runtime-infra-'));
}

/** Records calls; responses matched by command-line prefix. */
function mockExec(responses: Array<{ match: (cmd: string) => boolean; stdout?: string; code?: number }> = []) {
  const calls: string[] = [];
  const exec: ExecFn = (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    const hit = responses.find((r) => r.match(line));
    return { stdout: hit?.stdout ?? '', code: hit?.code ?? 0 };
  };
  return { exec, calls };
}

describe('infraEnabled', () => {
  it('matches space-delimited services exactly', () => {
    const env = { HARNESS_INFRA_SERVICES: 'db minio headless-browser' };
    expect(infraEnabled(env, 'db')).toBe(true);
    expect(infraEnabled(env, 'minio')).toBe(true);
    expect(infraEnabled(env, 'mailpit')).toBe(false);
    expect(infraEnabled(env, 'headless')).toBe(false);
    expect(infraEnabled({}, 'db')).toBe(false);
  });
});

describe('infraPortLane', () => {
  const env = {
    HARNESS_INFRA_PORT_LANES: 'db=15432:15432-15499 minio=19000:19000-19099 mailpit-web=18025:18025-18099',
  };

  it('parses declared lanes', () => {
    expect(infraPortLane(env, 'db')).toEqual({ defaultPort: 15432, scanStart: 15432, scanEnd: 15499 });
    expect(infraPortLane(env, 'mailpit-web')).toEqual({ defaultPort: 18025, scanStart: 18025, scanEnd: 18099 });
  });

  it('returns undefined for undeclared lanes', () => {
    expect(infraPortLane(env, 'browser')).toBeUndefined();
    expect(infraPortLane({}, 'db')).toBeUndefined();
  });

  it('throws on a malformed entry (same as the bash helper)', () => {
    expect(() => infraPortLane({ HARNESS_INFRA_PORT_LANES: 'db=15432' }, 'db')).toThrow(
      "malformed HARNESS_INFRA_PORT_LANES entry 'db=15432' (expected <lane>=<default>:<start>-<end>)",
    );
  });

  it('falls back to legacy HARNESS_<LANE>_PORT_* triplets', () => {
    const legacy = {
      HARNESS_DB_PORT_DEFAULT: '25432',
      HARNESS_DB_PORT_SCAN_START: '25432',
      HARNESS_DB_PORT_SCAN_END: '25460',
      HARNESS_MAILPIT_WEB_PORT_DEFAULT: '28025',
    };
    expect(infraPortLane(legacy, 'db')).toEqual({ defaultPort: 25432, scanStart: 25432, scanEnd: 25460 });
    // start/end default to the declared default (bash ${!s_var:-${!d_var}})
    expect(infraPortLane(legacy, 'mailpit-web')).toEqual({
      defaultPort: 28025,
      scanStart: 28025,
      scanEnd: 28025,
    });
  });

  it('infraPortDefault returns lane default or fallback', () => {
    expect(infraPortDefault(env, 'db', 1)).toBe(15432);
    expect(infraPortDefault(env, 'browser', 13001)).toBe(13001);
  });
});

describe('infra state file', () => {
  it('writes the byte-identical setup-infra.sh format and round-trips', () => {
    const harnessDir = tmpDir();
    writeInfraState(harnessDir, PORTS);
    const written = fs.readFileSync(path.join(harnessDir, 'state', 'infra.env'), 'utf8');
    expect(written).toBe(
      '# Persisted by setup-infra.sh — host ports for shared docker compose services.\n' +
        'export AGENT_DB_PORT=15432\n' +
        'export AGENT_MINIO_PORT=19000\n' +
        'export AGENT_MINIO_CONSOLE_PORT=19050\n' +
        'export AGENT_BROWSER_PORT=13001\n' +
        'export AGENT_MAILPIT_WEB_PORT=18025\n' +
        'export AGENT_MAILPIT_SMTP_PORT=11025\n',
    );
    expect(readInfraState(harnessDir)).toEqual(PORTS);
  });

  it('reads empty state when the file is absent', () => {
    expect(readInfraState(tmpDir())).toEqual({});
  });
});

describe('resolveInfraPort', () => {
  const env = {
    HARNESS_PROJECT_NAME: 'proj',
    HARNESS_INFRA_PORT_LANES: 'db=15432:15432-15435',
  };

  it('keeps a persisted port that is free', () => {
    const { exec } = mockExec();
    const port = resolveInfraPort('db', 15432, 'db', {
      env,
      current: 15433,
      exec,
      portInUse: () => false,
    });
    expect(port).toBe(15433);
  });

  it('keeps a persisted busy port when its compose service holds it', () => {
    const { exec } = mockExec([
      { match: (c) => c.startsWith('docker ps'), stdout: 'har-proj-db-1\n' },
    ]);
    const port = resolveInfraPort('db', 15432, 'db', {
      env,
      current: 15433,
      exec,
      portInUse: () => true,
    });
    expect(port).toBe(15433);
  });

  it('scans the lane when the persisted port is held by something else', () => {
    const { exec } = mockExec(); // docker ps returns nothing
    const busy = new Set([15433, 15432]);
    const port = resolveInfraPort('db', 15432, 'db', {
      env,
      current: 15433,
      exec,
      portInUse: (p) => busy.has(p),
    });
    expect(port).toBe(15434);
  });

  it('uses the fallback default when no lane is declared', () => {
    const { exec } = mockExec();
    const port = resolveInfraPort('browser', 13001, undefined, {
      env,
      exec,
      portInUse: () => false,
    });
    expect(port).toBe(13001);
  });
});

describe('composeServiceRunning', () => {
  it('matches the exact <project>-<service>-1 container name', () => {
    const env = { HARNESS_PROJECT_NAME: 'proj' };
    const { exec, calls } = mockExec([
      { match: (c) => c.startsWith('docker ps'), stdout: 'har-proj-db-1\nother\n' },
    ]);
    expect(composeServiceRunning(env, 'db', exec)).toBe(true);
    expect(calls[0]).toBe('docker ps --filter name=har-proj-db-1 --format {{.Names}}');
    const miss = mockExec([{ match: () => true, stdout: 'har-proj-db-10\n' }]);
    expect(composeServiceRunning(env, 'db', miss.exec)).toBe(false);
  });
});

describe('runPg', () => {
  const env = { HARNESS_PROJECT_NAME: 'proj' };

  it('uses the host tool with -h/-p/-U when installed', () => {
    const { exec, calls } = mockExec();
    runPg('psql', ['-d', 'postgres', '-c', 'SELECT 1'], {
      env,
      dbPort: 15499,
      exec,
      hasHostTool: () => true,
    });
    expect(calls[0]).toBe('psql -h localhost -p 15499 -U postgres -d postgres -c SELECT 1');
  });

  it('falls back to docker exec into har-<project>-db-1', () => {
    const { exec, calls } = mockExec();
    runPg('createdb', ['-T', 'tmpl', 'agent_1'], { env, exec, hasHostTool: () => false });
    expect(calls[0]).toBe(
      'docker exec -i -e PGPASSWORD=password har-proj-db-1 createdb -U postgres -T tmpl agent_1',
    );
  });

  it('defaults the port from the db lane', () => {
    const { exec, calls } = mockExec();
    runPg('psql', [], {
      env: { ...env, HARNESS_INFRA_PORT_LANES: 'db=25432:25432-25499' },
      exec,
      hasHostTool: () => true,
    });
    expect(calls[0]).toContain('-p 25432');
  });
});

describe('cloneAgentDatabase', () => {
  const env = {
    HARNESS_PROJECT_NAME: 'proj',
    HARNESS_INFRA_SERVICES: 'db',
    HARNESS_TEMPLATE_DB: 'tmpl_db',
  };

  it('skips when the database exists', () => {
    const { exec, calls } = mockExec([
      { match: (c) => c.includes('pg_database WHERE datname'), stdout: '1\n' },
    ]);
    const logs: string[] = [];
    cloneAgentDatabase(3, { env, exec, hasHostTool: () => true, log: (m) => logs.push(m) });
    expect(logs).toEqual(["Database 'agent_3' already exists."]);
    expect(calls.filter((c) => c.includes('createdb'))).toHaveLength(0);
  });

  it('terminates template backends then clones with createdb -T', () => {
    const { exec, calls } = mockExec();
    const logs: string[] = [];
    cloneAgentDatabase(2, { env, exec, hasHostTool: () => true, log: (m) => logs.push(m) });
    expect(calls.some((c) => c.includes('pg_terminate_backend') && c.includes("'tmpl_db'"))).toBe(true);
    expect(calls[calls.length - 1]).toBe('createdb -h localhost -p 15432 -U postgres -T tmpl_db agent_2');
    expect(logs).toEqual(["Creating database 'agent_2' from template...", "Database 'agent_2' created."]);
  });

  it('does nothing when db infra is off or no template db', () => {
    const { exec, calls } = mockExec();
    cloneAgentDatabase(1, { env: { HARNESS_INFRA_SERVICES: '' }, exec });
    cloneAgentDatabase(1, { env: { HARNESS_INFRA_SERVICES: 'db' }, exec });
    expect(calls).toHaveLength(0);
  });
});

describe('dropAgentDatabase', () => {
  it('terminates connections and drops with --if-exists', () => {
    const { exec, calls } = mockExec();
    dropAgentDatabase(4, {
      env: { HARNESS_PROJECT_NAME: 'proj', HARNESS_INFRA_SERVICES: 'db' },
      exec,
      hasHostTool: () => true,
    });
    expect(calls[0]).toContain("datname='agent_4'");
    expect(calls[1]).toBe('dropdb -h localhost -p 15432 -U postgres --if-exists agent_4');
  });
});

describe('minio buckets', () => {
  it('ensureMinioBucket PUTs and logs the launch.sh line', async () => {
    const requests: string[] = [];
    const logs: string[] = [];
    await ensureMinioBucket(5, 19007, {
      env: { HARNESS_INFRA_SERVICES: 'minio' },
      log: (m) => logs.push(m),
      httpRequest: async (method, url) => {
        requests.push(`${method} ${url}`);
        return 200;
      },
    });
    expect(requests).toEqual(['PUT http://localhost:19007/agent-5/']);
    expect(logs).toEqual(["MinIO bucket 'agent-5' ready (HTTP 200)."]);
  });

  it('removeMinioBucket force-deletes on the teardown.sh URL', async () => {
    const requests: string[] = [];
    await removeMinioBucket(5, {
      env: { HARNESS_INFRA_SERVICES: 'minio' },
      httpRequest: async (method, url) => {
        requests.push(`${method} ${url}`);
        return 204;
      },
    });
    expect(requests).toEqual(['DELETE http://localhost:19000/agent-5?force=true']);
  });
});

describe('setupInfra', () => {
  it('persists ports, composes up enabled services, and readies the template db', async () => {
    const harnessDir = tmpDir();
    const repoRoot = path.dirname(harnessDir);
    const env = {
      HARNESS_PROJECT_NAME: 'proj',
      HARNESS_INFRA_SERVICES: 'db minio',
      HARNESS_TEMPLATE_DB: 'tmpl_db',
      HARNESS_INFRA_PORT_LANES: 'db=15432:15432-15499 minio=19000:19000-19099',
    };
    const { exec, calls } = mockExec([
      { match: (c) => c.startsWith('pg_isready'), code: 0 },
    ]);
    const logs: string[] = [];

    const ports = await setupInfra({
      harnessDir,
      repoRoot,
      env,
      exec,
      log: (m) => logs.push(m),
      sleep: async () => undefined,
      portInUse: () => false,
      hasHostTool: () => true,
    });

    expect(ports.AGENT_DB_PORT).toBe(15432);
    expect(fs.existsSync(path.join(harnessDir, 'state', 'infra.env'))).toBe(true);
    const composeCall = calls.find((c) => c.startsWith('docker compose'));
    expect(composeCall).toBe(
      `docker compose -p har-proj -f ${path.join(harnessDir, 'docker-compose.agent.yml')} up -d db minio`,
    );
    expect(calls.some((c) => c.includes('CREATE EXTENSION IF NOT EXISTS pg_stat_statements'))).toBe(true);
    expect(calls.some((c) => c.includes('CREATE DATABASE tmpl_db'))).toBe(true);
    expect(calls.some((c) => c.includes('SET datistemplate = true'))).toBe(true);
    expect(logs).toContain('Starting shared infrastructure (project: har-proj): db minio');
    expect(logs).toContain('Infrastructure is ready.');
    expect(logs).toContain('  PostgreSQL: localhost:15432');
    expect(logs).toContain('  MinIO:      http://localhost:19050');
  });

  it('skips the template-db flow when templateDbFlow is false (cli profile)', async () => {
    const harnessDir = tmpDir();
    const env = {
      HARNESS_PROJECT_NAME: 'proj',
      HARNESS_INFRA_SERVICES: 'db',
      HARNESS_TEMPLATE_DB: 'tmpl_db',
    };
    const { exec, calls } = mockExec();
    await setupInfra({
      harnessDir,
      repoRoot: path.dirname(harnessDir),
      env,
      templateDbFlow: false,
      exec,
      log: () => undefined,
      sleep: async () => undefined,
      portInUse: () => false,
      hasHostTool: () => true,
    });
    expect(calls.some((c) => c.includes('CREATE DATABASE'))).toBe(false);
    expect(calls.some((c) => c.includes('pg_stat_statements'))).toBe(true);
  });

  it('logs the no-services message when HARNESS_INFRA_SERVICES is empty', async () => {
    const harnessDir = tmpDir();
    const { exec, calls } = mockExec();
    const logs: string[] = [];
    await setupInfra({
      harnessDir,
      repoRoot: path.dirname(harnessDir),
      env: { HARNESS_PROJECT_NAME: 'proj' },
      exec,
      log: (m) => logs.push(m),
      sleep: async () => undefined,
      portInUse: () => false,
    });
    expect(logs).toContain('No shared infra services enabled in harness.env (HARNESS_INFRA_SERVICES)');
    expect(calls.some((c) => c.startsWith('docker compose'))).toBe(false);
  });
});
