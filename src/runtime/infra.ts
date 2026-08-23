import * as fs from 'fs';
import * as path from 'path';
import { isPortInUse } from '../core/slot-ports';
import { defaultExec, ExecFn, LogFn, SleepFn, realSleep, stderrLog } from './exec';

/**
 * Package-side shared-infra runtime (#234) — the TS home of setup-infra.sh,
 * lib/infra.sh, and the infra halves of launch.sh/teardown.sh. Behavior is
 * byte-compatible where observable: .har/state/infra.env contents, port-lane
 * resolution, compose project naming, template-DB flow, and log lines.
 */

// ── harness.env-driven config (mirrors lib/infra.sh) ─────────────────────────

/** har_infra_enabled: service is listed in space-delimited HARNESS_INFRA_SERVICES. */
export function infraEnabled(env: Record<string, string>, service: string): boolean {
  const services = (env.HARNESS_INFRA_SERVICES ?? '').split(/\s+/).filter(Boolean);
  return services.includes(service);
}

export interface InfraPortLane {
  defaultPort: number;
  scanStart: number;
  scanEnd: number;
}

/**
 * har_infra_port_lane: parse "<lane>=<default>:<start>-<end>" entries from
 * HARNESS_INFRA_PORT_LANES, honoring the legacy per-lane
 * HARNESS_<LANE>_PORT_DEFAULT/_SCAN_START/_SCAN_END triplets as fallback.
 * Returns undefined when the lane is not declared anywhere.
 * Throws on a malformed declared entry (the bash helper errors there too).
 */
export function infraPortLane(
  env: Record<string, string>,
  lane: string,
): InfraPortLane | undefined {
  for (const entry of (env.HARNESS_INFRA_PORT_LANES ?? '').split(/\s+/).filter(Boolean)) {
    if (!entry.startsWith(`${lane}=`)) continue;
    const spec = entry.slice(lane.length + 1);
    const match = spec.match(/^(\d+):(\d+)-(\d+)$/);
    if (!match) {
      throw new Error(
        `malformed HARNESS_INFRA_PORT_LANES entry '${entry}' (expected <lane>=<default>:<start>-<end>)`,
      );
    }
    return {
      defaultPort: Number(match[1]),
      scanStart: Number(match[2]),
      scanEnd: Number(match[3]),
    };
  }

  const prefix = `HARNESS_${lane.toUpperCase().replace(/-/g, '_')}_PORT`;
  const declaredDefault = env[`${prefix}_DEFAULT`];
  if (declaredDefault) {
    const defaultPort = Number(declaredDefault);
    return {
      defaultPort,
      scanStart: Number(env[`${prefix}_SCAN_START`] ?? declaredDefault),
      scanEnd: Number(env[`${prefix}_SCAN_END`] ?? declaredDefault),
    };
  }
  return undefined;
}

/** har_infra_port_default: the lane's default port, or the fallback. */
export function infraPortDefault(
  env: Record<string, string>,
  lane: string,
  fallback: number,
): number {
  try {
    return infraPortLane(env, lane)?.defaultPort ?? fallback;
  } catch {
    return fallback;
  }
}

// ── Postgres client wrapper (har_pg) ─────────────────────────────────────────

export interface PgOptions {
  env: Record<string, string>;
  /** Persisted AGENT_DB_PORT; defaults to the db lane default (15432). */
  dbPort?: number;
  exec?: ExecFn;
  /** Host-tool availability probe — tests override; default checks PATH. */
  hasHostTool?: (tool: string) => boolean;
}

function hostToolExists(tool: string, exec: ExecFn): boolean {
  return exec('sh', ['-c', `command -v ${tool}`]).code === 0;
}

/**
 * har_pg: run a Postgres client tool against the shared db — host tools when
 * installed, otherwise docker exec into "har-<project>-db-1".
 */
export function runPg(tool: string, args: string[], options: PgOptions): { stdout: string; code: number } {
  const exec = options.exec ?? defaultExec;
  const dbPort = options.dbPort ?? infraPortDefault(options.env, 'db', 15432);
  const available = options.hasHostTool
    ? options.hasHostTool(tool)
    : hostToolExists(tool, exec);
  if (available) {
    return exec(tool, ['-h', 'localhost', '-p', String(dbPort), '-U', 'postgres', ...args], {
      env: { ...process.env, PGPASSWORD: 'password' },
    });
  }
  const container = `har-${options.env.HARNESS_PROJECT_NAME}-db-1`;
  return exec('docker', ['exec', '-i', '-e', 'PGPASSWORD=password', container, tool, '-U', 'postgres', ...args]);
}

// ── Persisted infra state (.har/state/infra.env) ─────────────────────────────

export const INFRA_LANES = [
  { stateVar: 'AGENT_DB_PORT', lane: 'db', fallback: 15432, composeService: 'db' },
  { stateVar: 'AGENT_MINIO_PORT', lane: 'minio', fallback: 19000, composeService: 'minio' },
  { stateVar: 'AGENT_MINIO_CONSOLE_PORT', lane: 'minio-console', fallback: 19050 },
  { stateVar: 'AGENT_BROWSER_PORT', lane: 'browser', fallback: 13001, composeService: 'headless-browser' },
  { stateVar: 'AGENT_MAILPIT_WEB_PORT', lane: 'mailpit-web', fallback: 18025, composeService: 'mailpit' },
  { stateVar: 'AGENT_MAILPIT_SMTP_PORT', lane: 'mailpit-smtp', fallback: 11025 },
] as const;

export type InfraStateVar = (typeof INFRA_LANES)[number]['stateVar'];
export type InfraPorts = Record<InfraStateVar, number>;

export function infraStatePath(harnessDir: string): string {
  return path.join(harnessDir, 'state', 'infra.env');
}

/** har_load_infra_state: parse the persisted `export KEY=value` lines. */
export function readInfraState(harnessDir: string): Partial<Record<string, number>> {
  const statePath = infraStatePath(harnessDir);
  if (!fs.existsSync(statePath)) return {};
  const ports: Record<string, number> = {};
  for (const line of fs.readFileSync(statePath, 'utf8').split('\n')) {
    const match = line.match(/^export\s+([A-Z_]+)=(\d+)\s*$/);
    if (match) ports[match[1]] = Number(match[2]);
  }
  return ports;
}

/** Byte-identical to the heredoc setup-infra.sh writes. */
export function writeInfraState(harnessDir: string, ports: InfraPorts): void {
  const statePath = infraStatePath(harnessDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    '# Persisted by setup-infra.sh — host ports for shared docker compose services.\n' +
      `export AGENT_DB_PORT=${ports.AGENT_DB_PORT}\n` +
      `export AGENT_MINIO_PORT=${ports.AGENT_MINIO_PORT}\n` +
      `export AGENT_MINIO_CONSOLE_PORT=${ports.AGENT_MINIO_CONSOLE_PORT}\n` +
      `export AGENT_BROWSER_PORT=${ports.AGENT_BROWSER_PORT}\n` +
      `export AGENT_MAILPIT_WEB_PORT=${ports.AGENT_MAILPIT_WEB_PORT}\n` +
      `export AGENT_MAILPIT_SMTP_PORT=${ports.AGENT_MAILPIT_SMTP_PORT}\n`,
  );
}

// ── Port resolution (har_resolve_infra_port) ─────────────────────────────────

export function composeProject(env: Record<string, string>): string {
  return `har-${env.HARNESS_PROJECT_NAME}`;
}

/** har_compose_service_running: docker ps name filter on "<project>-<service>-1". */
export function composeServiceRunning(
  env: Record<string, string>,
  service: string,
  exec: ExecFn = defaultExec,
): boolean {
  const name = `${composeProject(env)}-${service}-1`;
  const result = exec('docker', ['ps', '--filter', `name=${name}`, '--format', '{{.Names}}']);
  if (result.code !== 0) return false;
  return result.stdout.split('\n').some((line) => line.trim() === name);
}

export interface ResolveInfraPortOptions {
  env: Record<string, string>;
  /** Persisted value from infra.env, when present. */
  current?: number;
  exec?: ExecFn;
  portInUse?: (port: number) => boolean;
}

/**
 * har_resolve_infra_port: keep the persisted port when it is free or its
 * compose service already holds it; otherwise allocate from the lane.
 */
export function resolveInfraPort(
  lane: string,
  fallback: number,
  composeService: string | undefined,
  options: ResolveInfraPortOptions,
): number {
  const portInUse = options.portInUse ?? isPortInUse;
  const current = options.current;
  if (
    current &&
    (!portInUse(current) ||
      (composeService && composeServiceRunning(options.env, composeService, options.exec)))
  ) {
    return current;
  }

  let laneInfo: InfraPortLane | undefined;
  try {
    laneInfo = infraPortLane(options.env, lane);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    laneInfo = undefined;
  }
  const defaultPort = laneInfo?.defaultPort ?? fallback;
  const scanStart = laneInfo?.scanStart ?? fallback;
  const scanEnd = laneInfo?.scanEnd ?? fallback;
  // har_allocate_port with the injected probe (core allocatePort hardwires isPortInUse).
  if (!portInUse(defaultPort)) return defaultPort;
  for (let port = scanStart; port <= scanEnd; port++) {
    if (!portInUse(port)) return port;
  }
  throw new Error(`no free port in range ${scanStart}-${scanEnd}`);
}

/** Resolve all six infra lanes against persisted state, setup-infra.sh order. */
export function resolveInfraPorts(
  env: Record<string, string>,
  persisted: Partial<Record<string, number>>,
  options: Omit<ResolveInfraPortOptions, 'env' | 'current'> = {},
): InfraPorts {
  const ports = {} as InfraPorts;
  for (const { stateVar, lane, fallback, ...rest } of INFRA_LANES) {
    const composeService = 'composeService' in rest ? rest.composeService : undefined;
    ports[stateVar] = resolveInfraPort(lane, fallback, composeService, {
      env,
      current: persisted[stateVar],
      ...options,
    });
  }
  return ports;
}

// ── setup-infra orchestration ─────────────────────────────────────────────────

export interface SetupInfraOptions {
  harnessDir: string;
  repoRoot: string;
  env: Record<string, string>;
  /**
   * Whether this harness runs the template-database flow (#236 feeds this from
   * the profile manifest). Default matches the pm2 boilerplate; the cli
   * profile passes false — per-slot databases are the pm2 profiles' concern.
   */
  templateDbFlow?: boolean;
  /** Prefix for pm2 invocations (har_pkg_exec); e.g. ["npx"]. */
  pkgExecPrefix?: string[];
  exec?: ExecFn;
  log?: LogFn;
  sleep?: SleepFn;
  portInUse?: (port: number) => boolean;
  hasHostTool?: (tool: string) => boolean;
}

/**
 * setup-infra.sh: resolve + persist infra ports, compose up the enabled
 * services, ready PostgreSQL (extension + optional template database), and
 * start optional shared app services. Idempotent.
 */
export async function setupInfra(options: SetupInfraOptions): Promise<InfraPorts> {
  const {
    harnessDir,
    repoRoot,
    env,
    templateDbFlow = true,
    pkgExecPrefix = ['npx'],
    exec = defaultExec,
    log = stderrLog,
    sleep = realSleep,
  } = options;

  const persisted = readInfraState(harnessDir);
  const ports = resolveInfraPorts(env, persisted, {
    exec,
    portInUse: options.portInUse,
  });
  writeInfraState(harnessDir, ports);

  const project = composeProject(env);
  const services = (env.HARNESS_INFRA_SERVICES ?? '').split(/\s+/).filter(Boolean);
  const composeFile = path.join(harnessDir, 'docker-compose.agent.yml');

  const portEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_DB_PORT: String(ports.AGENT_DB_PORT),
    AGENT_MINIO_PORT: String(ports.AGENT_MINIO_PORT),
    AGENT_MINIO_CONSOLE_PORT: String(ports.AGENT_MINIO_CONSOLE_PORT),
    AGENT_BROWSER_PORT: String(ports.AGENT_BROWSER_PORT),
    AGENT_MAILPIT_WEB_PORT: String(ports.AGENT_MAILPIT_WEB_PORT),
    AGENT_MAILPIT_SMTP_PORT: String(ports.AGENT_MAILPIT_SMTP_PORT),
  };

  if (services.length > 0) {
    log(`Starting shared infrastructure (project: ${project}): ${services.join(' ')}`);
    const up = exec(
      'docker',
      ['compose', '-p', project, '-f', composeFile, 'up', '-d', ...services],
      { env: portEnv },
    );
    if (up.code !== 0) {
      throw new Error(`docker compose up failed for project ${project}`);
    }
  } else {
    log('No shared infra services enabled in harness.env (HARNESS_INFRA_SERVICES)');
  }

  const pg = (tool: string, args: string[]) =>
    runPg(tool, args, { env, dbPort: ports.AGENT_DB_PORT, exec, hasHostTool: options.hasHostTool });
  const psql = (args: string[]) => pg('psql', ['-d', 'postgres', ...args]);

  if (infraEnabled(env, 'db')) {
    log(`Waiting for PostgreSQL on port ${ports.AGENT_DB_PORT}...`);
    let ready = false;
    for (let i = 1; i <= 30; i++) {
      if (pg('pg_isready', ['-q']).code === 0) {
        log('PostgreSQL is ready.');
        ready = true;
        break;
      }
      if (i === 30) break;
      await sleep(1);
    }
    if (!ready) {
      throw new Error('PostgreSQL did not become ready within 30 seconds.');
    }

    log('Enabling pg_stat_statements extension...');
    psql(['-c', 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements']);

    const templateDb = env.HARNESS_TEMPLATE_DB;
    if (templateDbFlow && templateDb) {
      const exists = psql(['-tAc', `SELECT 1 FROM pg_database WHERE datname = '${templateDb}'`]);
      if (exists.stdout.includes('1')) {
        log(`Template database '${templateDb}' already exists. Skipping creation.`);
      } else {
        log(`Creating template database '${templateDb}'...`);
        const create = psql(['-c', `CREATE DATABASE ${templateDb}`]);
        if (create.code !== 0) throw new Error(`could not create database ${templateDb}`);

        const dbEnv: NodeJS.ProcessEnv = {
          ...process.env,
          PGPASSWORD: 'password',
          PGHOST: 'localhost',
          PGPORT: String(ports.AGENT_DB_PORT),
          PGUSER: 'postgres',
          PGDATABASE: templateDb,
        };
        if (env.HARNESS_DB_MIGRATE_CMD) {
          log('Running migrations...');
          const migrate = exec('bash', ['-c', `cd '${repoRoot}' && ${env.HARNESS_DB_MIGRATE_CMD}`], { env: dbEnv });
          if (migrate.code !== 0) throw new Error('migrations failed');
        }
        if (env.HARNESS_DB_SEED_CMD) {
          log('Running seeds...');
          const seed = exec('bash', ['-c', `cd '${repoRoot}' && ${env.HARNESS_DB_SEED_CMD}`], { env: dbEnv });
          if (seed.code !== 0) throw new Error('seeds failed');
        }

        log(`Marking '${templateDb}' as a PostgreSQL template...`);
        psql(['-c', `UPDATE pg_database SET datistemplate = true WHERE datname = '${templateDb}'`]);
        log(`Template database ready: ${templateDb}`);
      }
    }
  }

  const sharedEcosystem = path.join(harnessDir, 'ecosystem.shared.config.cjs');
  if (fs.existsSync(sharedEcosystem)) {
    log('Starting shared app services from ecosystem.shared.config.cjs...');
    const [pkgCmd, ...pkgArgs] = pkgExecPrefix;
    exec(pkgCmd, [...pkgArgs, 'pm2', 'startOrReload', sharedEcosystem], { cwd: repoRoot });
    log(`Shared app services running (pm2 ls | grep har-${env.HARNESS_PROJECT_NAME}-shared-).`);
  }

  log('Infrastructure is ready.');
  if (infraEnabled(env, 'db')) log(`  PostgreSQL: localhost:${ports.AGENT_DB_PORT}`);
  if (infraEnabled(env, 'minio')) log(`  MinIO:      http://localhost:${ports.AGENT_MINIO_CONSOLE_PORT}`);
  if (infraEnabled(env, 'headless-browser')) log(`  Browser:    http://localhost:${ports.AGENT_BROWSER_PORT}`);
  if (infraEnabled(env, 'mailpit')) log(`  Mailpit:    http://localhost:${ports.AGENT_MAILPIT_WEB_PORT}`);
  return ports;
}

// ── Per-slot database / bucket lifecycle (launch.sh + teardown.sh halves) ────

export interface AgentDbOptions {
  env: Record<string, string>;
  dbPort?: number;
  exec?: ExecFn;
  log?: LogFn;
  hasHostTool?: (tool: string) => boolean;
}

/** launch.sh: clone agent_<id> from HARNESS_TEMPLATE_DB when db infra is on. */
export function cloneAgentDatabase(agentId: number, options: AgentDbOptions): void {
  const { env, exec = defaultExec, log = stderrLog } = options;
  const templateDb = env.HARNESS_TEMPLATE_DB;
  if (!infraEnabled(env, 'db') || !templateDb) return;
  const agentDb = `agent_${agentId}`;
  const pgOpts = { env, dbPort: options.dbPort, exec, hasHostTool: options.hasHostTool };
  const psql = (args: string[]) => runPg('psql', ['-d', 'postgres', ...args], pgOpts);

  const exists = psql(['-tAc', `SELECT 1 FROM pg_database WHERE datname = '${agentDb}'`]);
  if (exists.stdout.includes('1')) {
    log(`Database '${agentDb}' already exists.`);
    return;
  }
  log(`Creating database '${agentDb}' from template...`);
  psql([
    '-c',
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${templateDb}' AND pid <> pg_backend_pid()`,
  ]);
  const create = runPg('createdb', ['-T', templateDb, agentDb], pgOpts);
  if (create.code !== 0) throw new Error(`could not create database ${agentDb}`);
  log(`Database '${agentDb}' created.`);
}

/** teardown.sh: terminate connections and drop agent_<id>. Never throws. */
export function dropAgentDatabase(agentId: number, options: AgentDbOptions): void {
  const { env, exec = defaultExec } = options;
  if (!infraEnabled(env, 'db')) return;
  const pgOpts = { env, dbPort: options.dbPort, exec, hasHostTool: options.hasHostTool };
  runPg(
    'psql',
    ['-d', 'postgres', '-c', `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='agent_${agentId}';`],
    pgOpts,
  );
  runPg('dropdb', ['--if-exists', `agent_${agentId}`], pgOpts);
}

export type HttpRequestFn = (method: string, url: string, auth?: string) => Promise<number>;

const defaultHttpRequest: HttpRequestFn = async (method, url, auth) => {
  try {
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = `Basic ${Buffer.from(auth).toString('base64')}`;
    const response = await fetch(url, { method, headers });
    return response.status;
  } catch {
    return 0;
  }
};

/** launch.sh: idempotent PUT of the agent-<id> bucket. */
export async function ensureMinioBucket(
  agentId: number,
  minioPort: number,
  options: { env: Record<string, string>; log?: LogFn; httpRequest?: HttpRequestFn },
): Promise<void> {
  if (!infraEnabled(options.env, 'minio')) return;
  const log = options.log ?? stderrLog;
  const request = options.httpRequest ?? defaultHttpRequest;
  const bucket = `agent-${agentId}`;
  const status = await request(
    'PUT',
    `http://localhost:${minioPort}/${bucket}/`,
    'minioadmin:minioadmin',
  );
  log(`MinIO bucket '${bucket}' ready (HTTP ${status || '000'}).`);
}

/** teardown.sh: force-delete the agent bucket. Never throws. */
export async function removeMinioBucket(
  agentId: number,
  options: { env: Record<string, string>; minioPort?: number; httpRequest?: HttpRequestFn },
): Promise<void> {
  if (!infraEnabled(options.env, 'minio')) return;
  const request = options.httpRequest ?? defaultHttpRequest;
  // teardown.sh hardcodes 19000 — keep that default for byte-compatible behavior.
  const port = options.minioPort ?? 19000;
  await request('DELETE', `http://localhost:${port}/agent-${agentId}?force=true`, 'minioadmin:minioadmin');
}
