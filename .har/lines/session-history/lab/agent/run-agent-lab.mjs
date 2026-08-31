#!/usr/bin/env node
/**
 * Session-history agent lab — station S1 (#191).
 *
 * A real Claude Code CLI against a scripted mock, then full verify and commit.
 * The question: the content snapshot recorded at verify and the commit created
 * afterwards share a tree, and that association is a binding, not a rename.
 *
 * Reuses the occupancy-identity Anthropic mock (sandbox HOME, no real model).
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockServer } from '../../../occupancy-identity/lab/agent/mock-anthropic.mjs';

const AGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.LAB_REPO_ROOT ?? path.resolve(AGENT_DIR, '..', '..', '..', '..', '..');
const HAR_CLI = process.env.LAB_HAR_CLI ?? path.join(REPO_ROOT, 'dist', 'index.js');
const KEEP = process.env.AGENT_LAB_KEEP === '1';
const SCENARIO = JSON.parse(
  readFileSync(
    path.join(REPO_ROOT, '.har/lines/occupancy-identity/lab/agent/scenario.json'),
    'utf8',
  ),
);

const log = (msg) => process.stderr.write(`${msg}\n`);
const checks = [];
const check = (ok, name, detail) => {
  checks.push({ ok: Boolean(ok), name, detail: ok ? null : detail ?? null });
  log(`  ${ok ? '✓' : '✗'} ${name}${ok || !detail ? '' : ` — ${detail}`}`);
};

function which(bin) {
  const result = spawnSync('sh', ['-lc', `command -v ${bin}`], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function har(args, env, cwd) {
  return execFileSync('node', [HAR_CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    env: { ...process.env, ...env },
  });
}

function git(args, cwd, env) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  }).trim();
}

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
    HAR_TELEMETRY: '0',
    XDG_CONFIG_HOME: path.join(labRoot, 'xdg-config'),
  };
}

function slimStages(repoDir) {
  const stagesPath = path.join(repoDir, '.har', 'stages.json');
  const registry = JSON.parse(readFileSync(stagesPath, 'utf8'));
  registry.verificationStages = ['smoke'];
  const kept = new Set(['setup-infra', 'launch', 'verify', 'status', 'teardown']);
  registry.stages = [
    ...registry.stages.filter((stage) => kept.has(stage.id)),
    {
      id: 'smoke',
      kind: 'test',
      description: 'Trivial full-verify stage for the history lab',
      command: 'true',
      artifacts: [],
      requiresAgentId: true,
      tier: 'full',
    },
  ];
  writeFileSync(stagesPath, `${JSON.stringify(registry, null, 2)}\n`);
}

function makeFixtureRepo(root, env) {
  const dir = path.join(root, 'fixture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'session-history-fixture', version: '1.0.0' }, null, 2)}\n`,
  );
  writeFileSync(path.join(dir, 'tracked.txt'), 'base\n');
  git(['init', '-q', '-b', 'main'], dir, env);
  git(['config', 'user.name', 'lab'], dir, env);
  git(['config', 'user.email', 'lab@example.invalid'], dir, env);
  git(['add', '-A'], dir, env);
  git(['commit', '-q', '-m', 'chore: fixture'], dir, env);
  har(['env', 'init', '--profile', 'cli', '--yes', '--repo', dir], env, dir);
  slimStages(dir);
  git(['add', '-A'], dir, env);
  git(['commit', '-q', '-m', 'chore: harness'], dir, env);
  har(['hooks', 'install', '--force', '--repo', dir], env, dir);
  return dir;
}

function activeSlot(repoDir, env) {
  const status = JSON.parse(har(['env', 'status', '--json', '--repo', repoDir], env, repoDir));
  return (status.slots ?? []).find((slot) => slot.agentId === 1) ?? null;
}

function runClaude({ claudeBin, workDir, env, scenario }) {
  writeFileSync(path.join(workDir, scenario.widgetFileName), scenario.widgetContents);
  const debugFile = path.join(path.dirname(workDir), `claude-debug-${path.basename(workDir)}.log`);
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
          /* ignore */
        }
        reject(new Error(`claude exited ${code}: ${(stderr || stdout).slice(-400)}\nDEBUG:\n${debugTail}`));
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

function readJsonDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), 'utf8')));
}

async function main() {
  const labRoot = mkdtempSync(path.join(tmpdir(), 'session-history-agent-lab-'));
  const homeDir = path.join(labRoot, 'home');
  const configDir = path.join(labRoot, 'claude-config');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });

  const claudeBin = process.env.CLAUDE_BIN ?? which('claude');
  check(existsSync(HAR_CLI), 'har CLI is built', HAR_CLI);
  check(Boolean(claudeBin), 'claude CLI is available', 'not on PATH and CLAUDE_BIN unset');
  if (!claudeBin || !existsSync(HAR_CLI)) return finish(labRoot);

  check(homeDir.startsWith(labRoot), 'the agent runs under a sandbox HOME', `HOME=${homeDir}`);

  const mock = await startMockServer({
    scenario: SCENARIO,
    widgetPath: path.join(labRoot, SCENARIO.widgetFileName),
    logPath: path.join(labRoot, 'mock-requests.jsonl'),
  });
  log(`==> mock Anthropic at ${mock.url}`);

  const env = isolatedEnv({ homeDir, configDir, labRoot, mockUrl: mock.url });
  try {
    const repoDir = makeFixtureRepo(labRoot, env);
    log(`==> fixture repo: ${repoDir}`);

    har(
      ['env', 'launch', '1', '--repo', repoDir, '--work-id', 'history-191', '--work-source', 'none'],
      env,
      repoDir,
    );
    const slot = activeSlot(repoDir, env);
    check(Boolean(slot?.workDir), 'slot 1 launched a worktree', JSON.stringify(slot));
    if (!slot?.workDir) return finish(labRoot, mock);

    const claude = await runClaude({
      claudeBin,
      workDir: slot.workDir,
      env,
      scenario: SCENARIO,
    });
    check(
      typeof claude.session_id === 'string' && claude.session_id.length > 0,
      'the lab ran a real Claude Code session',
      JSON.stringify(claude).slice(0, 200),
    );

    writeFileSync(path.join(slot.workDir, 'tracked.txt'), 'changed-by-session\n');
    har(['env', 'verify', '1', '--full', '--repo', repoDir], env, repoDir);

    const validations = readJsonDir(path.join(slot.workDir, '.har', 'validations'));
    check(validations.length > 0, 'full verify wrote a content snapshot', `${validations.length} records`);
    const snapshot = validations[0];
    check(
      Boolean(snapshot?.treeHash) && snapshot.treeHash !== snapshot.headSha,
      'the content snapshot is not the base commit SHA',
      `${snapshot?.treeHash} vs ${snapshot?.headSha}`,
    );

    git(['add', '-A'], slot.workDir, env);
    git(['commit', '-q', '-m', 'feat: session history lab change'], slot.workDir, env);
    const commitSha = git(['rev-parse', 'HEAD'], slot.workDir, env);
    const commitTree = git(['rev-parse', 'HEAD^{tree}'], slot.workDir, env);

    check(commitTree === snapshot.treeHash, 'the commit tree matches the verified snapshot', commitTree);
    check(commitSha !== commitTree, 'commit SHA and content snapshot stay different objects', commitSha);

    const bindings = [
      ...readJsonDir(path.join(slot.workDir, '.har', 'commit-bindings')),
      ...readJsonDir(path.join(repoDir, '.har', 'commit-bindings')),
    ];
    const match = bindings.find((row) => row.commitSha === commitSha && row.treeHash === commitTree);
    check(Boolean(match), 'post-commit wrote a commit binding for this snapshot', `${bindings.length} bindings`);
    check(
      !match || match.validationId === snapshot.validationId,
      'the binding points at the same validation as the snapshot',
      match?.validationId,
    );

    har(['env', 'teardown', '1', '--repo', repoDir], env, repoDir);
  } catch (err) {
    check(false, 'lab run completed', String(err?.message ?? err).slice(0, 800));
  } finally {
    await mock.close?.();
  }

  finish(labRoot);
}

function finish(labRoot, mock) {
  mock?.close?.();
  const failed = checks.filter((c) => !c.ok);
  const report = {
    status: failed.length === 0 ? 'pass' : 'fail',
    stageId: 'session-history-agent-lab',
    kind: 'test',
    home: homedir(),
    checks,
  };
  const artifacts = process.env.SESSION_HISTORY_LAB_ARTIFACTS;
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(path.join(artifacts, 'agent-lab-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  if (!KEEP) rmSync(labRoot, { recursive: true, force: true });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  check(false, 'lab bootstrapped', String(err?.stack ?? err).slice(0, 500));
  finish(process.env.TMPDIR ?? tmpdir());
});
