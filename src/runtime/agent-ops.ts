import { spawnSync } from 'child_process';
import { readHarnessEnv } from '../harness/env';
import { resolveHarnessRoot } from '../harness/manifest';
import { loadAgentPorts, collectEnvironmentStatus, renderEnvironmentStatusText } from '../core/slot-status';
import { loadInfraState } from '../core/slot-ports';
import { readSlotRegistry } from '../core/slot-registry';
import { defaultExec, ExecFn, realSystemOps, SystemOps } from './exec';
import { infraEnabled, runPg } from './infra';
import { pm2SlotPrefix, tmuxSessionName } from './process';
import { pkgExec } from './node-pm';

export const AGENT_OP_COMMANDS = [
  'status', 'logs', 'restart', 'psql', 'health', 'url',
  'reset-db', 'slow-queries', 'exec', 'attach',
] as const;

export interface AgentOpOptions {
  repoPath: string;
  agentId: number;
  command: string;
  args?: string[];
  out?: (message: string) => void;
  exec?: ExecFn;
  ops?: SystemOps;
  /** Foreground spawn for interactive/streaming commands (logs, psql, attach, exec). */
  spawn?: (cmd: string, args: string[], env?: NodeJS.ProcessEnv, cwd?: string) => number;
}

const defaultSpawn = (
  cmd: string,
  args: string[],
  env?: NodeJS.ProcessEnv,
  cwd?: string,
): number => {
  const result = spawnSync(cmd, args, { stdio: 'inherit', env: env ?? process.env, cwd });
  return result.status ?? 1;
};

/**
 * The agent-cli.sh command set, package-side (#234): per-slot ops against the
 * running environment. One implementation for the CLI (`har env agent`) and
 * the generated shim.
 */
export async function runAgentOp(options: AgentOpOptions): Promise<{ code: number }> {
  const repoRoot = resolveHarnessRoot(options.repoPath);
  const env = readHarnessEnv(repoRoot);
  const agentId = options.agentId;
  const args = options.args ?? [];
  const out = options.out ?? ((message: string) => process.stdout.write(`${message}\n`));
  const exec = options.exec ?? defaultExec;
  const ops = options.ops ?? realSystemOps;
  const spawn = options.spawn ?? defaultSpawn;
  const projectName = env.HARNESS_PROJECT_NAME ?? '';
  const prefix = pm2SlotPrefix(projectName, agentId);
  const pkgExecArgv = pkgExec(undefined, env, ops).split(' ');
  const ports = loadAgentPorts(repoRoot, agentId);
  const dbPort = ports.db ?? 15432;
  const pgEnv = { ...process.env, PGPASSWORD: 'password' };

  switch (options.command) {
    case 'status': {
      const full = collectEnvironmentStatus(repoRoot);
      const filtered = { ...full, slots: full.slots.filter((slot) => slot.agentId === agentId) };
      out(renderEnvironmentStatusText(filtered).trimEnd());
      return { code: 0 };
    }

    case 'logs': {
      const service = args[0];
      const pm2Args = service
        ? ['pm2', 'logs', `${prefix}-${service}`, '--lines', '100']
        : ['pm2', 'logs', '--name', prefix, '--lines', '100'];
      return { code: spawn(pkgExecArgv[0], [...pkgExecArgv.slice(1), ...pm2Args], pgEnv) };
    }

    case 'restart': {
      const service = args[0];
      if (service) {
        const result = exec(pkgExecArgv[0], [...pkgExecArgv.slice(1), 'pm2', 'restart', `${prefix}-${service}`]);
        process.stdout.write(result.stdout);
        return { code: result.code };
      }
      const jlist = exec(pkgExecArgv[0], [...pkgExecArgv.slice(1), 'pm2', 'jlist']);
      let names: string[] = [];
      try {
        const parsed = JSON.parse(jlist.stdout) as Array<{ name?: string }>;
        names = parsed
          .map((p) => p.name ?? '')
          .filter((name) => name.startsWith(`${prefix}-`));
      } catch {
        /* no pm2 or empty list — fall through to the no-processes message */
      }
      if (names.length === 0) {
        out(`No processes found for ${prefix}`);
        return { code: 0 };
      }
      for (const name of names) {
        spawn(pkgExecArgv[0], [...pkgExecArgv.slice(1), 'pm2', 'restart', name]);
      }
      return { code: 0 };
    }

    case 'psql': {
      const query = args[0];
      const psqlArgs = query ? ['-d', `agent_${agentId}`, '-c', query] : ['-d', `agent_${agentId}`];
      if (!query) {
        // Interactive session — hand the terminal over.
        return { code: spawn('psql', ['-h', 'localhost', '-p', String(dbPort), '-U', 'postgres', ...psqlArgs], pgEnv) };
      }
      const result = runPg('psql', psqlArgs, { env, dbPort, exec });
      process.stdout.write(result.stdout);
      return { code: result.code };
    }

    case 'health': {
      const healthPath = env.HARNESS_HEALTH_CHECK_PATH;
      if (!healthPath) {
        out('No health check path configured in harness.env');
        return { code: 0 };
      }
      const url = `http://localhost:${ports.api}${healthPath}`;
      try {
        const response = await fetch(url);
        const body = await response.text();
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        try {
          out(JSON.stringify(JSON.parse(body), null, 2));
        } catch {
          out(body);
        }
        return { code: 0 };
      } catch (err) {
        process.stderr.write(`health check failed for ${url}: ${err instanceof Error ? err.message : String(err)}\n`);
        return { code: 1 };
      }
    }

    case 'url': {
      const infraState = loadInfraState(repoRoot, repoRoot);
      out(`Frontend:  http://localhost:${ports.frontend}`);
      out(`API:       http://localhost:${ports.api}`);
      if (infraEnabled(env, 'db')) out(`Database:  agent_${agentId} @ localhost:${dbPort}`);
      if (infraEnabled(env, 'minio')) {
        out(`MinIO:     http://localhost:${infraState.AGENT_MINIO_CONSOLE_PORT ?? 19050}`);
      }
      if (infraEnabled(env, 'headless-browser')) {
        out(`Browser:   http://localhost:${infraState.AGENT_BROWSER_PORT ?? 13001}`);
      }
      if (infraEnabled(env, 'mailpit')) {
        out(`Mailpit:   http://localhost:${infraState.AGENT_MAILPIT_WEB_PORT ?? 18025}`);
      }
      return { code: 0 };
    }

    case 'reset-db': {
      out(`==> Resetting database for agent ${agentId}...`);
      runPg('psql', [
        '-d', 'postgres', '-c',
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='agent_${agentId}';`,
      ], { env, dbPort, exec });
      const drop = runPg('dropdb', ['--if-exists', `agent_${agentId}`], { env, dbPort, exec });
      if (drop.code !== 0) return { code: drop.code };
      const create = runPg('createdb', ['-T', env.HARNESS_TEMPLATE_DB ?? '', `agent_${agentId}`], { env, dbPort, exec });
      if (create.code !== 0) return { code: create.code };
      out('✓ Database reset to clean state');
      return { code: 0 };
    }

    case 'slow-queries': {
      const result = runPg('psql', [
        '-d', `agent_${agentId}`, '-c',
        `
SELECT round(mean_exec_time::numeric, 2) AS mean_ms,
       calls,
       left(query, 120) AS query
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;`,
      ], { env, dbPort, exec });
      if (result.code !== 0) {
        out('pg_stat_statements extension not available');
        return { code: 0 };
      }
      process.stdout.write(result.stdout);
      return { code: 0 };
    }

    case 'exec': {
      if (args.length === 0) {
        process.stderr.write(`Usage: har env agent ${agentId} exec <command>\n`);
        return { code: 1 };
      }
      const session = readSlotRegistry(repoRoot, agentId);
      const workDir = session?.workDir && session.workDir.length > 0 ? session.workDir : repoRoot;
      const execEnv = {
        ...process.env,
        PGHOST: 'localhost',
        PGPORT: String(dbPort),
        PGUSER: 'postgres',
        PGDATABASE: `agent_${agentId}`,
        PGPASSWORD: 'password',
      };
      return { code: spawn('bash', ['-c', args.join(' ')], execEnv, workDir) };
    }

    case 'attach': {
      const tmux = tmuxSessionName(projectName, agentId);
      const has = exec('tmux', ['has-session', '-t', tmux]);
      if (has.code !== 0) {
        process.stderr.write(`No tmux session found: ${tmux}\n`);
        return { code: 1 };
      }
      return { code: spawn('tmux', ['attach', '-t', tmux]) };
    }

    default:
      process.stderr.write(`Unknown command: ${options.command}\n\n`);
      process.stderr.write('Commands: status, logs [service], restart [service], psql [query],\n');
      process.stderr.write('          health, url, reset-db, slow-queries, exec <cmd>, attach\n');
      return { code: 1 };
  }
}
