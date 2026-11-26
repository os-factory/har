#!/usr/bin/env node
// Verification runner: executes the stages.json verification plan.
// Invoked by `har env verify` after it sources harness.env and the agent env
// file (so the full slot environment is inherited). Replaces the bash
// run_step/run_http_step/RESULTS_JSON plumbing: step names may contain any
// characters, no result is ever silently dropped, and stage env vars are
// passed as real environment entries instead of eval'd shell prefixes.
//
// Usage: verify-runner.mjs --agent <id> [--full]
// Env:   HAR_HARNESS_DIR (the .har dir), WORK_DIR (step cwd)
//
// Contract (stdout): { status, agent_id, total_ms, stages: [{name, pass, ms, output?}] }
// Quick mode stops at the first failing step; full mode runs the whole plan.
//
// Stage logs (ADR 0005 section 4): each stage's stdout and stderr are kept
// interleaved in arrival order, and only the LAST 1 MiB is held in memory (a
// ring buffer). With HAR_STAGE_LOG_DIR set, the runner writes
// <dir>/<stage-id>.log and <dir>/index.json, which lists per stage the log and
// the files the stage created or changed under <WORK_DIR>/.har/<artifactsDir>/.
// `har env verify` then moves <dir> to .har/<artifactsDir>/<factory-run-id>/.
//
// Log file format: the output as is when it is at most 1 MiB. Longer output
// starts with ONE header line, `[har] <N> bytes dropped, last <K> bytes kept\n`,
// followed by the last K bytes; the header counts toward the cap, so the whole
// file is at most 1048576 bytes. The cut never starts inside a UTF-8 sequence
// (up to 3 continuation bytes after the cut are dropped too, and counted in N).

import { spawn } from 'node:child_process';
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';

const RUNNABLE_KINDS = new Set(['test', 'custom']);

const args = process.argv.slice(2);
const full = args.includes('--full');
const agentIdx = args.indexOf('--agent');
const agentId = agentIdx >= 0 ? Number(args[agentIdx + 1]) : NaN;
if (!Number.isInteger(agentId)) {
  process.stderr.write('verify-runner: --agent <id> is required\n');
  process.exit(2);
}

const harnessDir = process.env.HAR_HARNESS_DIR;
const workDir = process.env.WORK_DIR;
if (!harnessDir || !workDir) {
  process.stderr.write('verify-runner: HAR_HARNESS_DIR and WORK_DIR must be set\n');
  process.exit(2);
}

let registry;
try {
  registry = JSON.parse(readFileSync(join(harnessDir, 'stages.json'), 'utf8'));
} catch (err) {
  process.stderr.write(`verify-runner: cannot read ${join(harnessDir, 'stages.json')}: ${err.message}\n`);
  process.exit(2);
}

const ids = Array.isArray(registry.verificationStages) ? registry.verificationStages : [];
const stages = Array.isArray(registry.stages) ? registry.stages : [];

const plan = [];
const phantoms = [];
for (const id of ids) {
  const stage = stages.find((s) => s && s.id === id);
  if (!stage || !RUNNABLE_KINDS.has(stage.kind)) {
    phantoms.push(id);
    continue;
  }
  if (!full && stage.tier !== 'quick') continue;
  plan.push(stage);
}

for (const id of phantoms) {
  process.stderr.write(
    `  ! verificationStages id "${id}" has no registered runnable stage — fix .har/stages.json (har env doctor reports this)\n`,
  );
}

function stepCommand(stage) {
  if (stage.script) {
    const script = resolve(harnessDir, stage.script);
    const quoted = `'${script.replace(/'/g, "'\\''")}'`;
    return stage.requiresAgentId === false ? quoted : `${quoted} ${agentId}`;
  }
  if (stage.command) {
    return stage.command.split('{agentId}').join(String(agentId));
  }
  return null;
}

// Failing output is cut to its LAST lines: compilers and test runners print the
// failing tests and the run summary at the end, after the build noise (#368).
const STDERR_TAIL_LINES = 30;
const RECORD_TAIL_LINES = 50;

function tailLines(text, max) {
  const lines = text.split('\n');
  if (lines.length <= max) return lines;
  return [`… (${lines.length - max} earlier lines omitted)`, ...lines.slice(-max)];
}

/** Bytes of a stage log kept on disk, header included (ADR 0005 section 4). */
const STAGE_LOG_LIMIT = 1024 * 1024;

/** Fixed-size byte ring: remembers the last `capacity` bytes written and the total. */
class TailBuffer {
  constructor(capacity) {
    this.buf = Buffer.alloc(capacity);
    this.capacity = capacity;
    this.start = 0;
    this.length = 0;
    this.total = 0;
  }

  write(chunk) {
    this.total += chunk.length;
    if (chunk.length >= this.capacity) {
      chunk.copy(this.buf, 0, chunk.length - this.capacity);
      this.start = 0;
      this.length = this.capacity;
      return;
    }
    let end = (this.start + this.length) % this.capacity;
    let offset = 0;
    while (offset < chunk.length) {
      const n = Math.min(chunk.length - offset, this.capacity - end);
      chunk.copy(this.buf, end, offset, offset + n);
      offset += n;
      end = (end + n) % this.capacity;
    }
    const overflow = Math.max(0, this.length + chunk.length - this.capacity);
    this.length = Math.min(this.capacity, this.length + chunk.length);
    this.start = (this.start + overflow) % this.capacity;
  }

  /** The kept bytes, oldest first. */
  bytes() {
    if (this.start + this.length <= this.capacity) {
      return Buffer.from(this.buf.subarray(this.start, this.start + this.length));
    }
    return Buffer.concat([this.buf.subarray(this.start), this.buf.subarray(0, (this.start + this.length) % this.capacity)]);
  }
}

/** The stage log as written: whole output, or a header line + the tail, at most `limit` bytes. */
function formatStageLog(tail, total, limit) {
  if (total <= limit) return tail;
  let budget = limit;
  for (;;) {
    let cut = Math.max(0, tail.length - budget);
    const stop = Math.min(tail.length, cut + 3);
    while (cut < stop && (tail[cut] & 0xc0) === 0x80) cut += 1;
    const kept = tail.length - cut;
    const header = Buffer.from(`[har] ${total - kept} bytes dropped, last ${kept} bytes kept\n`);
    if (header.length + kept <= limit) return Buffer.concat([header, tail.subarray(cut)]);
    budget = Math.min(budget - 1, limit - header.length);
  }
}

function runStep(cmd, options) {
  return new Promise((done) => {
    const tail = new TailBuffer(STAGE_LOG_LIMIT);
    let child;
    try {
      child = spawn('bash', ['-c', cmd], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      tail.write(Buffer.from(`${err.message}\n`));
      done({ status: 1, tail });
      return;
    }
    child.stdout.on('data', (chunk) => tail.write(chunk));
    child.stderr.on('data', (chunk) => tail.write(chunk));
    child.on('error', (err) => tail.write(Buffer.from(`${err.message}\n`)));
    child.on('close', (code) => done({ status: code ?? 1, tail }));
  });
}

const stageLogDir = process.env.HAR_STAGE_LOG_DIR ? resolve(process.env.HAR_STAGE_LOG_DIR) : undefined;
// Stages never see it: a stage that runs another verify must not write into this one's logs.
const stageBaseEnv = { ...process.env };
delete stageBaseEnv.HAR_STAGE_LOG_DIR;
const artifactsRoot = join(workDir, '.har', typeof registry.artifactsDir === 'string' && registry.artifactsDir ? registry.artifactsDir : 'artifacts');
const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ATTRIBUTED_FILES = 1000;

/**
 * Regular files under the artifacts dir → "size:mtime:ino". Other factory runs'
 * log directories (UUID-named, top level) and the log staging dir are skipped.
 */
function snapshotArtifacts() {
  const files = new Map();
  if (!stageLogDir) return files;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (depth === 0 && (UUID_DIR.test(entry.name) || entry.name === '.staging')) continue;
      if (full === stageLogDir) continue;
      if (entry.isDirectory()) {
        if (depth < 16) walk(full, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = lstatSync(full);
        files.set(relative(artifactsRoot, full).split(sep).join('/'), `${st.size}:${st.mtimeMs}:${st.ino}`);
      } catch {
        // vanished between readdir and stat
      }
    }
  };
  walk(artifactsRoot, 0);
  return files;
}

function changedArtifacts(before, after) {
  const changed = [];
  for (const [name, sig] of after) {
    if (before.get(name) !== sig) changed.push(name);
  }
  return changed.sort().slice(0, MAX_ATTRIBUTED_FILES);
}

function stageLogFileName(id) {
  return `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.log`;
}

const index = { version: 1, limitBytes: STAGE_LOG_LIMIT, stages: [] };
if (stageLogDir) {
  try {
    mkdirSync(stageLogDir, { recursive: true });
  } catch (err) {
    process.stderr.write(`verify-runner: cannot create ${stageLogDir}: ${err.message}\n`);
  }
}

const results = [];
let overallPass = true;
const startTotal = Date.now();

for (const stage of plan) {
  const cmd = stepCommand(stage);
  if (cmd === null) {
    results.push({ name: stage.id, pass: false, ms: 0, output: 'stage has neither script nor command' });
    overallPass = false;
    if (!full) break;
    continue;
  }

  process.stderr.write(`  → ${`${stage.id}...`.padEnd(40)}`);
  const before = snapshotArtifacts();
  const start = Date.now();
  const child = await runStep(cmd, {
    cwd: stage.cwd ? resolve(workDir, stage.cwd) : workDir,
    env: { ...stageBaseEnv, ...(stage.env ?? {}), HAR_AGENT_ID: String(agentId) },
  });
  const ms = Date.now() - start;
  const kept = child.tail.bytes();
  const output = kept.toString('utf8').trim();
  const pass = child.status === 0;

  if (stageLogDir) {
    const log = stageLogFileName(stage.id);
    const entry = { id: stage.id, log: null, totalBytes: child.tail.total, artifacts: changedArtifacts(before, snapshotArtifacts()) };
    try {
      writeFileSync(join(stageLogDir, log), formatStageLog(kept, child.tail.total, STAGE_LOG_LIMIT));
      entry.log = log;
    } catch (err) {
      process.stderr.write(`verify-runner: cannot write the ${stage.id} log: ${err.message}\n`);
    }
    index.stages.push(entry);
  }

  if (pass) {
    process.stderr.write(`✓ (${ms}ms)\n`);
    results.push({ name: stage.id, pass: true, ms });
  } else {
    process.stderr.write(`✗ (${ms}ms)\n`);
    for (const line of tailLines(output, STDERR_TAIL_LINES)) {
      process.stderr.write(`    ${line}\n`);
    }
    results.push({
      name: stage.id,
      pass: false,
      ms,
      output: tailLines(output, RECORD_TAIL_LINES).join('\n'),
    });
    overallPass = false;
    if (!full) break;
  }
}

if (stageLogDir) {
  try {
    writeFileSync(join(stageLogDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`verify-runner: cannot write the stage log index: ${err.message}\n`);
  }
}

const out = {
  status: overallPass && results.length > 0 ? 'pass' : 'fail',
  agent_id: agentId,
  total_ms: Date.now() - startTotal,
  stages: results,
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(out.status === 'pass' ? 0 : 1);
