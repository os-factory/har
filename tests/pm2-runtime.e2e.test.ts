import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * The bundled PM2 runtime, end to end (#475). The built CLI launches a real
 * PM2-profile slot (one ~10-line node HTTP server, no database, no Docker)
 * with a PATH that holds only node, git, bash and coreutils — no npx, bunx,
 * pnpm, yarn or global pm2 — so the only pm2 it can run is the one HAR ships
 * as a dependency. A spawn tracer records every child process the CLI starts.
 *
 * Isolation: HOME and PM2_HOME live in a temp dir. Every pm2 command here —
 * including cleanup — carries that PM2_HOME, so the developer's own daemon
 * (~/.pm2) is never touched; afterAll kills only the temp daemon. Ports sit
 * in the 47xxx range, away from real slots.
 *
 * Opt-in (starts a real PM2 daemon):
 *   npm run build && HAR_PM2_E2E=1 npx jest tests/pm2-runtime.e2e.test.ts --forceExit
 */

const ROOT = path.resolve(__dirname, '..');
const HAR_BIN = path.join(ROOT, 'dist', 'index.js');
const TRACER = path.join(__dirname, 'helpers', 'spawn-tracer.cjs');
const run = process.env.HAR_PM2_E2E === '1' ? describe : describe.skip;

const PROJECT = 'pm2e2e';
const PROCESS_NAME = `har-${PROJECT}-agent-1-api`;
const FE_BASE = 47300;
const API_BASE = 47400;

/** Tools the launch may need; package runners and pm2 are deliberately absent. */
const ALLOWED_TOOLS = [
  'git', 'bash', 'sh', 'env', 'cat', 'mkdir', 'rm', 'ls', 'sed', 'grep', 'awk', 'cp', 'mv',
  'ln', 'chmod', 'dirname', 'basename', 'readlink', 'realpath', 'head', 'tail', 'tr', 'cut',
  'sort', 'uniq', 'wc', 'date', 'sleep', 'touch', 'printf', 'test', 'id', 'uname', 'mktemp',
  'find', 'xargs', 'ps', 'tee', 'true', 'false', 'expr',
];
const FORBIDDEN_TOOLS = ['npx', 'npm', 'bunx', 'bun', 'pnpm', 'yarn', 'pm2'];

const SERVER_JS = `const http = require('http');
const port = Number(process.env.PORT);
http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, path: req.url, agent: process.env.AGENT_ID }));
  })
  .listen(port, '127.0.0.1');
`;

/** launch renders `\${AGENT_ID}` / `\${HARNESS_PROJECT_NAME}` before PM2 reads it. */
const ECOSYSTEM_TEMPLATE = [
  "const fs = require('fs');",
  "const path = require('path');",
  'const env = {};',
  "for (const line of fs.readFileSync(path.resolve(__dirname, '.env.agent.${AGENT_ID}'), 'utf8').split('\\n')) {",
  '  const m = line.match(/^\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*=\\s*(.*?)\\s*$/);',
  "  if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2].replace(/^[\"']|[\"']$/g, '');",
  '}',
  'module.exports = {',
  '  apps: [{',
  "    name: 'har-${HARNESS_PROJECT_NAME}-agent-${AGENT_ID}-api',",
  "    script: path.join(__dirname, 'server.js'),",
  '    interpreter: process.execPath,',
  '    cwd: __dirname,',
  '    env: { ...env, PORT: env.API_PORT },',
  '    autorestart: false,',
  '  }],',
  '};',
  '',
].join('\n');

interface Pm2Row {
  name?: string;
  pid?: number;
  pm2_env?: { status?: string; pm_cwd?: string; PM2_HOME?: string };
}
interface TraceRow {
  fn: string;
  command: string;
}

/** `^X.Y.Z` (or an exact version) satisfied by `version`. */
function satisfiesCaret(range: string, version: string): boolean {
  const parse = (v: string) => v.replace(/^[\^~=v]+/, '').split('.').map((n) => Number.parseInt(n, 10));
  const [rMaj, rMin, rPat] = parse(range);
  const [maj, min, pat] = parse(version);
  if (!range.startsWith('^')) return rMaj === maj && rMin === min && rPat === pat;
  if (maj !== rMaj) return false;
  return min > rMin || (min === rMin && pat >= rPat);
}

run('bundled pm2 runtime end to end (built CLI, temp PM2_HOME, no package runner on PATH)', () => {
  let base = '';
  let home = '';
  let pm2Home = '';
  let repo = '';
  let binDir = '';
  let traceFile = '';
  // Resolved in beforeAll: describe.skip still runs this body at collection time.
  let bundledPm2 = '';
  let bundledVersion = '';
  let declaredRange = '';

  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const out: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      PM2_HOME: pm2Home,
      PATH: binDir,
      HAR_TELEMETRY: 'off',
      HAR_SKIP_TELEMETRY_POSTINSTALL: '1',
      GIT_AUTHOR_NAME: 'e2e',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'e2e',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
      GIT_CONFIG_NOSYSTEM: '1',
      ...extra,
    };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'NODE_OPTIONS']) {
      if (!(key in extra)) delete out[key];
    }
    return out;
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
      cwd,
      env: env(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const har = (args: string[], extra: Record<string, string> = {}) =>
    spawnSync(process.execPath, [HAR_BIN, ...args], {
      cwd: repo,
      env: env(extra),
      encoding: 'utf8',
      timeout: 180_000,
    });
  /** The bundled pm2 — ALWAYS with the temp PM2_HOME. */
  const pm2 = (...args: string[]) =>
    spawnSync(process.execPath, [bundledPm2, ...args], {
      env: { ...env(), PM2_HOME: pm2Home },
      encoding: 'utf8',
      timeout: 30_000,
    });
  const jlist = (): Pm2Row[] => {
    const out = pm2('jlist');
    if (out.status !== 0) throw new Error(`pm2 jlist failed: ${out.stderr}`);
    return JSON.parse(out.stdout) as Pm2Row[];
  };
  const daemonPid = (): number | undefined => {
    try {
      const pid = Number.parseInt(fs.readFileSync(path.join(pm2Home, 'pm2.pid'), 'utf8').trim(), 10);
      return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
      return undefined;
    }
  };
  const readTrace = (): TraceRow[] =>
    fs.existsSync(traceFile)
      ? fs
          .readFileSync(traceFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as TraceRow)
      : [];
  const slotApiPort = (): number => {
    const entry = JSON.parse(
      fs.readFileSync(path.join(repo, '.har', 'slots', 'agent-1.json'), 'utf8'),
    ) as { ports?: { api?: number } };
    if (!entry.ports?.api) throw new Error('slot registry has no api port');
    return entry.ports.api;
  };

  let launch: ReturnType<typeof har>;

  beforeAll(() => {
    if (!fs.existsSync(HAR_BIN)) throw new Error('build the CLI first: npm run build');
    // The pm2 HAR ships: what dist/index.js resolves via require.resolve at runtime.
    bundledPm2 = require.resolve('pm2/bin/pm2', { paths: [ROOT] });
    bundledVersion = (
      JSON.parse(fs.readFileSync(path.join(path.dirname(bundledPm2), '..', 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
    declaredRange = (
      JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>;
      }
    ).dependencies.pm2;
    // Unix sockets cap at ~104-108 bytes: PM2_HOME/rpc.sock must stay short,
    // or the daemon never binds and every pm2 call hangs.
    const tmpRoot = os.tmpdir().length > 40 ? '/tmp' : os.tmpdir();
    base = fs.realpathSync(fs.mkdtempSync(path.join(tmpRoot, 'har-pm2-e2e-')));
    home = path.join(base, 'home');
    pm2Home = path.join(base, '.pm2');
    repo = path.join(base, 'repo');
    binDir = path.join(base, 'bin');
    traceFile = path.join(base, 'launch-trace.jsonl');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    // Minimal PATH: node plus a fixed allowlist, each linked by absolute path.
    fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
    for (const tool of ALLOWED_TOOLS) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (found.startsWith('/')) fs.symlinkSync(found, path.join(binDir, tool));
    }

    // A tiny PM2-profile repository: one node HTTP server, no DB, no Docker.
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'README.md'), '# pm2 e2e\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');
    const init = har(['env', 'init', '--profile', 'default', '--yes', '--no-cursor-rule', '--no-agents', '--commit-gate', 'never']);
    if (init.status !== 0) throw new Error(`env init failed:\n${init.stdout}\n${init.stderr}`);

    const harnessEnvPath = path.join(repo, '.har', 'harness.env');
    const harnessEnv = fs
      .readFileSync(harnessEnvPath, 'utf8')
      .replace(/^export HARNESS_PROJECT_NAME=.*$/m, `export HARNESS_PROJECT_NAME=${PROJECT}`)
      .replace(/^export HARNESS_INFRA_SERVICES=.*$/m, 'export HARNESS_INFRA_SERVICES=""')
      .replace(/^export HARNESS_TEMPLATE_DB=.*$/m, '')
      .replace(/^export HARNESS_ECOSYSTEM=.*$/m, 'export HARNESS_ECOSYSTEM="none"')
      .replace(/^export HARNESS_FE_BASE_PORT=.*$/m, `export HARNESS_FE_BASE_PORT=${FE_BASE}`)
      .replace(/^export HARNESS_API_BASE_PORT=.*$/m, `export HARNESS_API_BASE_PORT=${API_BASE}`)
      .replace(/^export HARNESS_HEALTH_CHECK_PATH=.*$/m, 'export HARNESS_HEALTH_CHECK_PATH=/health');
    fs.writeFileSync(harnessEnvPath, harnessEnv);
    fs.writeFileSync(path.join(repo, '.har', 'ecosystem.agent.template.cjs'), ECOSYSTEM_TEMPLATE);
    fs.writeFileSync(path.join(repo, 'server.js'), SERVER_JS);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'pm2 harness');

    launch = har(['env', 'launch', '1'], {
      NODE_OPTIONS: `--require ${TRACER}`,
      HAR_SPAWN_TRACE: traceFile,
    });
  }, 240_000);

  afterAll(() => {
    if (pm2Home && fs.existsSync(pm2Home)) {
      // Temp PM2_HOME only — never the developer's ~/.pm2.
      pm2('kill');
    }
    if (process.env.HAR_PM2_E2E_KEEP === '1') process.stderr.write(`kept ${base}\n`);
    else if (base) fs.rmSync(base, { recursive: true, force: true });
  }, 60_000);

  it('runs with no package runner or global pm2 on PATH', () => {
    for (const tool of FORBIDDEN_TOOLS) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { env: env(), encoding: 'utf8' });
      expect({ tool, found: found.stdout.trim() }).toEqual({ tool, found: '' });
    }
    expect(fs.existsSync(path.join(binDir, 'node'))).toBe(true);
  });

  it('launches slot 1 through the bundled pm2', () => {
    if (launch.status !== 0) {
      throw new Error(`env launch 1 failed (${launch.status}):\n${launch.stdout}\n${launch.stderr}`);
    }
    expect(launch.stderr + launch.stdout).toContain('Health check passed!');

    const trace = readTrace();
    const pm2Invocations = trace.filter((r) => r.command.includes(`${bundledPm2} `));
    expect(pm2Invocations.map((r) => r.command)).toEqual(
      expect.arrayContaining([expect.stringMatching(new RegExp(`^${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} .*pm2/bin/pm2 start `))]),
    );
    // Nothing went through a package runner or a PATH pm2.
    expect(trace.filter((r) => /^(npx|bunx|pnpm|yarn|npm|pm2)\b/.test(r.command))).toEqual([]);
    expect(trace.filter((r) => /\b(npx|bunx) .*pm2\b/.test(r.command))).toEqual([]);
  });

  it('the temp daemon runs the bundled pm2 version and shows the slot process online', () => {
    const pid = daemonPid();
    expect(pid).toBeDefined();
    const title = spawnSync('ps', ['-o', 'args=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
    expect(title).toBe(`PM2 v${bundledVersion}: God Daemon (${pm2Home})`);
    expect(fs.readFileSync(path.join(pm2Home, 'pm2.log'), 'utf8')).toMatch(
      new RegExp(`PM2 version\\s*:\\s*${bundledVersion.replace(/\./g, '\\.')}`),
    );
    expect(satisfiesCaret(declaredRange, bundledVersion)).toBe(true);

    const procs = jlist();
    const app = procs.find((p) => p.name === PROCESS_NAME);
    expect(app).toBeDefined();
    expect(app?.pm2_env?.status).toBe('online');
    expect(app?.pm2_env?.pm_cwd).toContain(path.join(home, 'worktrees'));
  });

  it('the service answers HTTP on the slot port', async () => {
    const port = slotApiPort();
    expect(port).toBeGreaterThanOrEqual(API_BASE);
    expect(port).toBeLessThan(API_BASE + 100);
    const res = await fetch(`http://127.0.0.1:${port}/ping`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, path: '/ping', agent: '1' });
  });

  it('env status reports the slot active with no pm2 issue', () => {
    const out = har(['env', 'status', '--json', '--repo', repo]);
    expect(out.status).toBe(0);
    const status = JSON.parse(out.stdout) as {
      slots: Array<{ agentId: number; active: boolean; sessionStatus?: string; pm2Issue?: string }>;
    };
    const slot = status.slots.find((s) => s.agentId === 1);
    expect(slot).toMatchObject({ active: true, sessionStatus: 'active' });
    expect(slot?.pm2Issue).toBeUndefined();
  });

  it('env teardown 1 removes the slot processes', async () => {
    const port = slotApiPort();
    const out = har(['env', 'teardown', '1']);
    if (out.status !== 0) throw new Error(`teardown failed:\n${out.stdout}\n${out.stderr}`);
    expect(jlist().filter((p) => p.name?.startsWith(`har-${PROJECT}-agent-1-`))).toEqual([]);
    await expect(fetch(`http://127.0.0.1:${port}/ping`)).rejects.toThrow();
  });
});
