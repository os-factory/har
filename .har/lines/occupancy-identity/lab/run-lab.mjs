#!/usr/bin/env node
/**
 * Occupancy lab entrypoint — station S3 of the occupancy-identity line (#316).
 *
 * Runs inside the lab container. Prepares a real Mission Control database, then
 * hands off to `control/src/server/occupancy-lab.lab.ts`, which drives a real
 * HAR launch → complete → launch cycle and asserts that occupancy B shows none
 * of occupancy A's identity.
 *
 * The container exists for one reason: an isolated HOME. On a laptop, Claude
 * Code transcripts under ~/.claude/projects/<encoded-cwd> outlive the worktree,
 * so a green run can mean "the machine was clean" rather than "the invariant
 * holds".
 *
 * Env:
 *   OCCUPANCY_LAB_KEEP=1            keep the scratch repo and database
 *   OCCUPANCY_LAB_ARTIFACTS=<dir>   write the lab report there
 *   OCCUPANCY_LAB_ALLOW_HOST_HOME=1 skip the sandbox assertions (host debugging)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const LAB_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = process.env.LAB_REPO_ROOT ?? path.resolve(LAB_DIR, '..', '..', '..', '..');
const CONTROL_DIR = path.join(REPO_ROOT, 'control');
const HAR_CLI = path.join(REPO_ROOT, 'dist', 'index.js');

const started = Date.now();
const log = (msg) => process.stderr.write(`${msg}\n`);

function emit(status, output) {
  const report = {
    status,
    stageId: 'occupancy-lab',
    kind: 'test',
    total_ms: Date.now() - started,
    home: homedir(),
    output: String(output ?? '').trim().split('\n').slice(-50).join('\n'),
  };
  const artifacts = process.env.OCCUPANCY_LAB_ARTIFACTS;
  if (artifacts) {
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(path.join(artifacts, 'lab-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(status === 'pass' ? 0 : 1);
}

function main() {
  if (!existsSync(HAR_CLI)) {
    emit('fail', `no built CLI at ${HAR_CLI} — run "npm run build" before the lab`);
  }

  const dbDir = mkdtempSync(path.join(tmpdir(), 'occupancy-lab-db-'));
  const dbPath = path.join(dbDir, 'lab.db');
  const env = {
    ...process.env,
    DATABASE_URL: `file:${dbPath}`,
    LAB_HAR_CLI: HAR_CLI,
    // The lab drives the CLI directly; telemetry would only add noise.
    HAR_TELEMETRY: '0',
  };

  let output = '';
  try {
    log('==> preparing the lab Mission Control database');
    output += execFileSync(
      'npx',
      ['prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'],
      { cwd: CONTROL_DIR, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );

    log('==> running the occupancy cycle (real CLI, real database)');
    output += execFileSync(
      'npx',
      ['vitest', 'run', '--config', 'vitest.lab.config.ts', '--reporter', 'verbose'],
      { cwd: CONTROL_DIR, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (err) {
    const detail = `${err?.stdout ?? ''}${err?.stderr ?? ''}` || String(err?.message ?? err);
    if (process.env.OCCUPANCY_LAB_KEEP !== '1') {
      rmSync(dbDir, { recursive: true, force: true });
    }
    emit('fail', `${output}\n${detail}`);
    return;
  }

  if (process.env.OCCUPANCY_LAB_KEEP !== '1') {
    rmSync(dbDir, { recursive: true, force: true });
  }
  emit('pass', output);
}

main();
