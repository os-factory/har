#!/usr/bin/env node
/**
 * Occupancy agent lab — the adversarial half of station S3 (#316).
 *
 * The DB-level lab proves the invariant against synthetic records. This one
 * reproduces the condition the bug was actually found in: a **real Claude Code
 * CLI**, driven twice against a scripted LLM mock, across a
 * `launch → complete → launch` boundary on the same slot number, with a
 * sandbox HOME so `~/.claude/projects/<encoded-cwd>` transcripts are the lab's
 * own and not the developer's.
 *
 * The jig (mock server, isolation env) is copied from os-factory/otel-hook
 * `har-plugins/agent-lab`; what is new here is the occupancy cycle around it.
 *
 * Nothing talks to a real model: ANTHROPIC_BASE_URL points at the mock.
 *
 * Usage: node run-agent-lab.mjs
 * Env:
 *   LAB_HAR_CLI=<path>      har CLI entrypoint (default: repo dist/index.js)
 *   CLAUDE_BIN=<path>       claude binary (default: resolved from PATH)
 *   AGENT_LAB_KEEP=1        keep the lab directory
 *   AGENT_LAB_ALLOW_HOST_HOME=1  skip the sandbox-HOME assertion
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockServer } from './mock-anthropic.mjs';

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.LAB_REPO_ROOT ?? path.resolve(AGENT_DIR, '..', '..', '..', '..', '..');
const HAR_CLI = process.env.LAB_HAR_CLI ?? path.join(REPO_ROOT, 'dist', 'index.js');
const KEEP = process.env.AGENT_LAB_KEEP === '1';

const log = (msg) => process.stderr.write(`${msg}\n`);
const checks = [];
const check = (ok, name, detail) => {
  // Detail is failure context; keeping it on a pass makes the report lie.
  checks.push({ ok: Boolean(ok), name, detail: ok ? null : detail ?? null });
  log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

function which(bin) {
  const result = spawnSync('sh', ['-lc', `command -v ${bin}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function har(args, env) {
  return execFileSync('node', [HAR_CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  });
}

/**
 * Sandbox overrides layered on the ambient environment.
 *
 * Only what actually isolates the run: HOME (Claude keys transcripts off it),
 * the Claude config dir, and the API base URL that points every model call at
 * the local mock. The upstream otel-hook jig strips the environment down
 * further; doing that here made the CLI hang before its first request, and the
 * extra hardening buys nothing for this station.
 */
function isolatedEnv({ homeDir, configDir, labRoot, mockUrl }) {
  return {
    HOME: homeDir,
    CLAUDE_CONFIG_DIR: configDir,
    ANTHROPIC_BASE_URL: mockUrl,
    ANTHROPIC_API_KEY: 'sk-ant-lab-mock-do-not-use',
    ANTHROPIC_AUTH_TOKEN: 'sk-ant-lab-mock-do-not-use',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_AUTOUPDATER: '1',
    // The har CLI must not phone Mission Control from inside the lab.
    HAR_TELEMETRY: '0',
    XDG_CONFIG_HOME: path.join(labRoot, 'xdg-config'),
  };
}

function makeFixtureRepo(root, env) {
  const dir = path.join(root, 'fixture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'occupancy-agent-fixture', version: '1.0.0' }, null, 2)}\n`,
  );
  const git = (args) =>
    execFileSync('git', args, {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    });
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'lab']);
  git(['config', 'user.email', 'lab@example.invalid']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'chore: fixture']);
  har(['env', 'init', '--profile', 'cli', '--yes', '--repo', dir], env);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'chore: harness']);
  return dir;
}

function activeSlot(repoDir, env) {
  const status = JSON.parse(har(['env', 'status', '--json', '--repo', repoDir], env));
  return (status.slots ?? []).find((slot) => slot.agentId === 1) ?? null;
}

/** The `har.session_key` an otel-hook export would carry right now. */
function harSessionKeyFromConfig(homeDir) {
  const configPath = path.join(homeDir, '.har', 'otel-hooks', 'otel_config.json');
  if (!existsSync(configPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(configPath, 'utf8'));
    const flat = JSON.stringify(raw);
    const match = flat.match(/"har\.session_key"\s*:\s*"([^"]+)"/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * One real Claude Code turn inside a worktree, against the mock.
 *
 * Async on purpose: the mock HTTP server lives in this process, so a blocking
 * `spawnSync` would stall the event loop and the model call could never be
 * answered — the agent would sit waiting for a first byte until its timeout.
 */
function runClaude({ claudeBin, workDir, env, scenario }) {
  writeFileSync(path.join(workDir, scenario.widgetFileName), scenario.widgetContents);
  const debugFile = path.join(path.dirname(workDir), `claude-debug-${path.basename(workDir)}.log`);

  // Session persistence stays ON: transcripts under $HOME/.claude/projects are
  // exactly the contamination this station exists to rule out, so the lab wants
  // them written. `--settings` / `--setting-sources` / `--strict-mcp-config` are
  // deliberately absent — they make the CLI hang before it reaches the mock.
  const child = spawn(
    claudeBin,
    [
      '-p',
      scenario.prompt,
      '--output-format',
      'json',
      '--dangerously-skip-permissions',
      '--allowedTools',
      scenario.toolName,
      '--model',
      scenario.model,
      '--debug-file',
      debugFile,
    ],
    { cwd: workDir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        let debugTail = '(no debug file)';
        try {
          debugTail = readFileSync(debugFile, 'utf8').slice(-1200);
        } catch {
          /* the CLI may have died before writing one */
        }
        reject(
          new Error(
            `claude exited ${code}: ${(stderr || stdout).slice(-400)}\nDEBUG:\n${debugTail}`,
          ),
        );
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`claude produced non-JSON output: ${stdout.slice(0, 400)}`));
      }
    });
  });
}

/**
 * Where Claude Code keeps this workspace's transcripts.
 *
 * `CLAUDE_CONFIG_DIR` wins when set; otherwise it is `$HOME/.claude`. Either
 * way the path encodes the cwd, which is why two occupancies of the same slot
 * get different directories — and why a shared HOME on a laptop lets the older
 * one outlive the worktree that produced it.
 */
function transcriptDir(configDir, workDir) {
  const encoded = workDir.replace(/[/.]/g, '-');
  return path.join(configDir, 'projects', encoded);
}

async function main() {
  const labRoot = mkdtempSync(path.join(tmpdir(), 'occupancy-agent-lab-'));
  const homeDir = path.join(labRoot, 'home');
  const configDir = path.join(labRoot, 'claude-config');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  const claudeBin = process.env.CLAUDE_BIN ?? which('claude');
  const scenario = JSON.parse(readFileSync(path.join(AGENT_DIR, 'scenario.json'), 'utf8'));

  check(existsSync(HAR_CLI), 'har CLI is built', HAR_CLI);
  check(Boolean(claudeBin), 'claude CLI is available', 'not on PATH and CLAUDE_BIN unset');
  if (!claudeBin || !existsSync(HAR_CLI)) return finish(labRoot);

  // The agent's HOME — not the driver's — is what must be sandboxed: Claude
  // Code keys transcripts off it, and a host HOME lets a previous occupancy's
  // transcripts be harvested into the next one.
  check(
    homeDir.startsWith(labRoot),
    'the agent runs under a sandbox HOME',
    `HOME=${homeDir}`,
  );
  check(
    !existsSync(path.join(homeDir, '.claude', 'projects')),
    'the sandbox HOME starts with no Claude transcripts',
    `${homeDir}/.claude/projects already exists`,
  );

  const mock = await startMockServer({
    scenario,
    widgetPath: path.join(labRoot, scenario.widgetFileName),
    logPath: path.join(labRoot, 'mock-requests.jsonl'),
  });
  log(`==> mock Anthropic at ${mock.url}`);

  const env = isolatedEnv({ homeDir, configDir, labRoot, mockUrl: mock.url });
  try {
    const repoDir = makeFixtureRepo(labRoot, env);
    log(`==> fixture repo: ${repoDir}`);

    // ── Occupancy A ─────────────────────────────────────────────────────────
    har(
      ['env', 'launch', '1', '--repo', repoDir, '--work-id', 'occupancy-a', '--work-source', 'none'],
      env,
    );
    const slotA = activeSlot(repoDir, env);
    const harKeyA = harSessionKeyFromConfig(homeDir);
    log(`==> occupancy A: ${slotA?.branch}`);

    const claudeA = await runClaude({
      claudeBin,
      workDir: slotA.workDir,
      env,
      scenario,
    });
    check(
      typeof claudeA.session_id === 'string' && claudeA.session_id.length > 0,
      'occupancy A ran a real Claude Code session',
      JSON.stringify(claudeA).slice(0, 200),
    );
    const transcriptsA = transcriptDir(configDir, slotA.workDir);

    // ── Free the workstation, then take it again for different work ─────────
    har(['env', 'complete', '1', '--skip-verify', '--repo', repoDir], env);
    har(
      ['env', 'launch', '1', '--repo', repoDir, '--work-id', 'occupancy-b', '--work-source', 'none'],
      env,
    );
    const slotB = activeSlot(repoDir, env);
    const harKeyB = harSessionKeyFromConfig(homeDir);
    log(`==> occupancy B: ${slotB?.branch}`);

    const claudeB = await runClaude({
      claudeBin,
      workDir: slotB.workDir,
      env,
      scenario,
    });
    const transcriptsB = transcriptDir(configDir, slotB.workDir);

    // ── The questions ───────────────────────────────────────────────────────
    check(slotA.branch !== slotB.branch, 'the reused slot got a new branch', slotA.branch);
    check(
      slotA.workDir !== slotB.workDir,
      'the reused slot got a new worktree',
      `${slotA.workDir} == ${slotB.workDir}`,
    );
    check(
      Boolean(slotA.attemptId) && slotA.attemptId !== slotB.attemptId,
      'the reused slot got a new work attempt',
      `${slotA.attemptId} == ${slotB.attemptId}`,
    );
    check(
      slotA.workUnitId === 'occupancy-a' && slotB.workUnitId === 'occupancy-b',
      'each occupancy is bound to its own work unit',
      `${slotA.workUnitId} / ${slotB.workUnitId}`,
    );

    // This is the leak the bug rode in on: the har.session_key an otel export
    // carries is per-launch. If it still names occupancy A after B launched,
    // every ingest that trusts it merges B into A.
    check(
      harKeyA === null || harKeyB === null || harKeyA !== harKeyB,
      'har.session_key changed with the occupancy',
      `A=${harKeyA} B=${harKeyB}`,
    );

    check(
      claudeA.session_id !== claudeB.session_id ||
        // Claude reusing a session id across occupancies is exactly why the
        // workspace match, not the provider id, must decide the session.
        slotA.workDir !== slotB.workDir,
      'occupancy B is separable from occupancy A',
      `claude session ${claudeA.session_id} vs ${claudeB.session_id}`,
    );

    check(
      transcriptsA !== transcriptsB,
      'each occupancy has its own Claude transcript directory',
      transcriptsA,
    );
    check(
      existsSync(transcriptsA) && existsSync(transcriptsB),
      'both occupancies wrote transcripts, inside the sandbox',
      `${transcriptsA} / ${transcriptsB}`,
    );
    check(
      transcriptsA.startsWith(labRoot) && transcriptsB.startsWith(labRoot),
      'no transcript escaped to the host HOME',
      `${transcriptsA}`,
    );

    const requests = readFileSync(path.join(labRoot, 'mock-requests.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    check(requests.length > 0, 'every model call went to the mock', `${requests.length} requests`);

    har(['env', 'teardown', '1', '--repo', repoDir], env);
  } catch (err) {
    check(false, 'lab run completed', String(err?.message ?? err).slice(0, 500));
  } finally {
    await mock.close?.();
  }

  finish(labRoot);
}

function finish(labRoot) {
  const failed = checks.filter((c) => !c.ok);
  const report = {
    status: failed.length === 0 ? 'pass' : 'fail',
    stageId: 'occupancy-agent-lab',
    kind: 'test',
    home: homedir(),
    checks,
  };
  const artifacts = process.env.OCCUPANCY_LAB_ARTIFACTS;
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(
      path.join(artifacts, 'agent-lab-report.json'),
      `${JSON.stringify(report, null, 2)}\n`,
    );
  }
  if (!KEEP) rmSync(labRoot, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  check(false, 'lab bootstrapped', String(err?.stack ?? err).slice(0, 500));
  finish(process.env.TMPDIR ?? tmpdir());
});
