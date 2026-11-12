import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentTool } from '../harness/schema';

/**
 * Which coding agent is the nearest ancestor of this process (ADR 0003).
 *
 * Agents nest and pass their session variables down, so the variables alone
 * cannot tell whose command this is. The process tree can: walking up from the
 * parent, the first process that is an agent — and whose session variable is
 * set — is the one running HAR.
 */

export interface ProcessInfo {
  ppid: number;
  /** argv[0] (or the executable name when argv is unavailable). */
  command: string;
  args: string[];
}

export type ProcessReader = (pid: number) => ProcessInfo | null;

const MAX_DEPTH = 32;

function readProcLinux(pid: number): ProcessInfo | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // `pid (comm) state ppid …` — comm may contain spaces and parentheses.
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(afterComm[1]);
    const argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    const comm = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
    return { ppid, command: argv[0] ?? comm, args: argv.slice(1) };
  } catch {
    return null;
  }
}

function readProcPs(pid: number): ProcessInfo | null {
  const result = spawnSync('ps', ['-o', 'ppid=', '-o', 'args=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 1000,
  });
  if (result.status !== 0 || !result.stdout) return null;
  const match = /^\s*(\d+)\s+(.*)$/.exec(result.stdout.trim());
  if (!match) return null;
  const [command, ...args] = match[2].split(/\s+/);
  return { ppid: Number(match[1]), command, args };
}

export function defaultProcessReader(): ProcessReader {
  if (process.platform === 'linux' && fs.existsSync('/proc/self/stat')) return readProcLinux;
  if (process.platform === 'win32') return () => null;
  return readProcPs;
}

/** The agent a process is, judged from its executable and arguments. */
export function agentToolOfProcess(info: ProcessInfo): AgentTool | null {
  const words = [info.command, ...info.args.slice(0, 2)];
  const names = words.map((word) => path.basename(word).toLowerCase());
  const joined = words.join(' ').toLowerCase();
  if (names.includes('claude') || joined.includes('@anthropic-ai/claude-code')) return 'claude_code';
  if (names.includes('codex') || joined.includes('@openai/codex')) return 'codex';
  if (
    names.some((name) => name === 'cursor' || name === 'cursor-agent' || name === 'cursor.mjs') ||
    // Linux packages run Cursor as `electron …/cursor/resources/app/cursor.mjs`.
    /[/\\]cursor[/\\]resources[/\\]app[/\\]/.test(joined)
  ) {
    return 'cursor';
  }
  return null;
}

/**
 * The nearest agent among this process's ancestors whose session is in `has`
 * (the agents whose variable is set), or null when none can be found.
 */
export function innermostAgentTool(options: {
  has: ReadonlySet<AgentTool>;
  startPid?: number;
  read?: ProcessReader;
}): AgentTool | null {
  if (options.has.size === 0) return null;
  const read = options.read ?? defaultProcessReader();
  let pid = options.startPid ?? process.ppid;
  const seen = new Set<number>();
  for (let depth = 0; depth < MAX_DEPTH && pid > 1 && !seen.has(pid); depth += 1) {
    seen.add(pid);
    const info = read(pid);
    if (!info) return null;
    const tool = agentToolOfProcess(info);
    if (tool && options.has.has(tool)) return tool;
    pid = info.ppid;
  }
  return null;
}
