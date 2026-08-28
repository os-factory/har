#!/usr/bin/env node
// Verification runner: executes the stages.json verification plan.
// Invoked by .har/verify.sh after it sources harness.env and the agent env
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

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

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
  const start = Date.now();
  const child = spawnSync('bash', ['-c', cmd], {
    cwd: stage.cwd ? resolve(workDir, stage.cwd) : workDir,
    env: { ...process.env, ...(stage.env ?? {}), HAR_AGENT_ID: String(agentId) },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const ms = Date.now() - start;
  const output = `${child.stdout ?? ''}${child.stderr ?? ''}`.trim();
  const pass = child.status === 0;

  if (pass) {
    process.stderr.write(`✓ (${ms}ms)\n`);
    results.push({ name: stage.id, pass: true, ms });
  } else {
    process.stderr.write(`✗ (${ms}ms)\n`);
    for (const line of output.split('\n').slice(0, 30)) {
      process.stderr.write(`    ${line}\n`);
    }
    results.push({
      name: stage.id,
      pass: false,
      ms,
      output: output.split('\n').slice(0, 50).join('\n'),
    });
    overallPass = false;
    if (!full) break;
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
