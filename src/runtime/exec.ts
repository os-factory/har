import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

// Two exec seams coexist here for now: SystemOps (async, streaming — used by
// provision/node-pm) and ExecFn (sync — used by infra/process/xcode-sim).
// The #234 integration pass may unify them; call sites only depend on their own seam.

/** Result of a runtime subprocess. */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Pipe child output through to the parent live (installs stream progress). */
  stream?: boolean;
  /** Discard child stderr (ports `2>/dev/null` call sites). Ignored when streaming. */
  quietStderr?: boolean;
}

/**
 * Subprocess + PATH probing seam for the package-side runtime (#234).
 * Runtime modules take a SystemOps so tests can fake the machine
 * (which tools are installed, what each command does) without spawning.
 */
export interface SystemOps {
  /** `command -v` equivalent: absolute path of an executable on PATH, or null. */
  which(cmd: string): string | null;
  /** Spawn a binary directly (no shell). */
  run(cmd: string, args: string[], opts?: RunOptions): Promise<ExecResult>;
  /** Run a command line through bash (HARNESS_INSTALL_CMD is eval'd shell). */
  runShell(command: string, opts?: RunOptions): Promise<ExecResult>;
  /** Trimmed stdout of a binary, or null when it fails to run or exits non-zero. */
  capture(cmd: string, args: string[], opts?: { cwd?: string; env?: NodeJS.ProcessEnv }): Promise<string | null>;
}

function spawnResult(
  cmd: string,
  args: string[],
  opts: RunOptions,
  shell: boolean,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const stream = opts.stream ?? false;
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      stdio: stream
        ? ['ignore', 'inherit', 'inherit']
        : ['ignore', 'pipe', opts.quietStderr ? 'ignore' : 'pipe'],
    });
    void shell;
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (c: Buffer) => (stdout += c.toString()));
    proc.stderr?.on('data', (c: Buffer) => (stderr += c.toString()));
    proc.on('error', (err) => resolve({ code: 127, stdout, stderr: stderr || String(err) }));
    proc.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export const realSystemOps: SystemOps = {
  which(cmd: string): string | null {
    if (cmd.includes('/')) {
      try {
        fs.accessSync(cmd, fs.constants.X_OK);
        return cmd;
      } catch {
        return null;
      }
    }
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
      if (!dir) continue;
      const candidate = path.join(dir, cmd);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep scanning */
      }
    }
    return null;
  },

  run(cmd, args, opts = {}) {
    return spawnResult(cmd, args, opts, false);
  },

  runShell(command, opts = {}) {
    return spawnResult('bash', ['-c', command], opts, true);
  },

  async capture(cmd, args, opts = {}) {
    const result = await spawnResult(cmd, args, { ...opts, quietStderr: true }, false);
    if (result.code !== 0) return null;
    const out = result.stdout.trim();
    return out.length > 0 ? out : null;
  },
};

/**
 * Injected process runner for the sync runtime modules (infra/process/xcode-sim).
 * Every docker/pm2/psql/simctl invocation goes through one of these so tests
 * can observe commands and script behavior stays byte-compatible.
 */
export type ExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string },
) => { stdout: string; code: number };

export const defaultExec: ExecFn = (command, args, options = {}) => {
  try {
    const stdout = execFileSync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      input: options.input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: stdout ?? '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? '', code: e.status ?? 1 };
  }
};

export type LogFn = (message: string) => void;

/** Matches the scripts' `log() { echo "==> $*" >&2; }`. */
export const stderrLog: LogFn = (message) => {
  process.stderr.write(`==> ${message}\n`);
};

export type SleepFn = (seconds: number) => Promise<void>;

export const realSleep: SleepFn = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));
