import { execSync, spawn, SpawnOptions } from 'child_process';

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
  /** True when `timeout` elapsed and the command was killed rather than exiting. */
  timedOut?: boolean;
}

export interface RunScriptOptions extends SpawnOptions {
  stream?: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Milliseconds before the command is killed. Callers that shell out to tools which
   * can stall indefinitely (xcodebuild resolving packages, say) need this — a timed-out
   * run reports `timedOut: true` so it can be told apart from a genuine failure.
   * Only the direct child is killed; grandchildren it spawned may outlive it.
   */
  timeout?: number;
}

export function run(command: string, options: RunOptions = {}): ShellResult {
  try {
    const stdout = execSync(command, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
      timeout: options.timeout,
    });
    return { stdout: stdout || '', stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      status?: number | null;
      signal?: string | null;
    };
    // execSync surfaces a timeout as a signal kill with a null status, which would
    // otherwise be indistinguishable from any other non-zero exit.
    const timedOut = options.timeout !== undefined && e.status == null && e.signal != null;
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      code: e.status ?? 1,
      ...(timedOut ? { timedOut: true } : {}),
    };
  }
}

export function runScript(
  scriptPath: string,
  args: string[] = [],
  options: RunScriptOptions = {},
): Promise<ShellResult> {
  return runScriptCapture(scriptPath, args, { ...options, stream: true });
}

export function runScriptCapture(
  scriptPath: string,
  args: string[] = [],
  options: RunScriptOptions = {},
): Promise<ShellResult> {
  const stream = options.stream ?? false;
  const { stream: _stream, ...spawnOptions } = options;
  void _stream;
  return new Promise((resolve) => {
    const proc = spawn('bash', [scriptPath, ...args], {
      ...spawnOptions,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d;
      if (stream) process.stdout.write(d);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d;
      if (stream) process.stderr.write(d);
    });
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

export function runShellCommand(
  command: string,
  options: RunScriptOptions = {},
): Promise<ShellResult> {
  const stream = options.stream ?? false;
  const { stream: _stream, ...spawnOptions } = options;
  void _stream;
  return new Promise((resolve) => {
    const proc = spawn('bash', ['-lc', command], {
      ...spawnOptions,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d;
      if (stream) process.stdout.write(d);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d;
      if (stream) process.stderr.write(d);
    });
    proc.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}
