import { execFileSync } from 'child_process';

/**
 * Injected process runner for the package-side runtime modules.
 * Every docker/pm2/psql/simctl invocation goes through one of these so tests
 * can observe commands and script behavior stays byte-compatible.
 */
export interface ExecResult {
  stdout: string;
  code: number;
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string },
) => ExecResult;

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
