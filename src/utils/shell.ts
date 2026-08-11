import { execSync, spawn, SpawnOptions } from 'child_process';

export interface ShellResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Quote a single token so it stays intact when a shell reads it (e.g. `source`d env files or `bash -lc`). */
export function quoteShellArg(arg: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export interface RunScriptOptions extends SpawnOptions {
  stream?: boolean;
}

export function run(command: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): ShellResult {
  try {
    const stdout = execSync(command, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    return { stdout: stdout || '', stderr: '', code: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      code: e.status ?? 1,
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
