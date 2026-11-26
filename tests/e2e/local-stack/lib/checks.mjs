#!/usr/bin/env node
// Checks of the local stack end-to-end test (no dependencies; Node >= 20).
//
//   checks.mjs <check> <state.json> [receiver|collector] [args...]
//
// Every check prints exactly one line, `PASS <label>: <detail>`,
// `FAIL <label>: <detail>` or `SKIP <label>: <why>` (a receiver whose adapter
// cannot read what the check needs), and exits 0; run.sh counts the FAILs.
// `probe-*` commands print a bare detail line and exit 1 on failure, for
// run.sh to fold into one of its own checks.
//
// Receivers are read through their read API (`<readBase>/v2/...`, the shapes of
// Mission Control's /api/v2 reads); spans, which have no read API, through the
// receiver's adapter (`<adapter> spans trace|session <id>`). Reads are retried
// for a while: ingestion is asynchronous for OTLP, and a restarted receiver
// catches up from the queues.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MIB = 1024 * 1024;
const SETTLE_MS = Number(process.env.HAR_E2E_SETTLE_MS ?? 30_000);
const STAGES = ['big-output', 'write-artifact'];
const DROPPED_LINE = /^\[har\] \d+ bytes dropped, last \d+ bytes kept$/;

const [command, stateFile, target, ...rest] = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const traceIdOf = (runId) => sha256(`factory-run:${runId}`).slice(0, 32);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Problem extends Error {}
class Skip extends Error {}
function need(condition, message) {
  if (!condition) throw new Problem(message);
}

function receiver(name) {
  const found = state.receivers.find((entry) => entry.name === name);
  if (!found) throw new Problem(`receiver ${name} is not configured`);
  return found;
}

async function read(rx, suffix, as = 'json') {
  const response = await fetch(`${rx.readBase}/${suffix}`, { headers: rx.headers ?? {} });
  if (!response.ok) throw new Problem(`GET ${suffix}: HTTP ${response.status}`);
  return as === 'json' ? response.json() : Buffer.from(await response.arrayBuffer());
}

function workUnitView(rx, workId = state.workId) {
  return read(rx, `v2/work-units/${encodeURIComponent(workId)}?repository=${encodeURIComponent(state.repoUrl)}`);
}

function spans(rx, field, value) {
  const out = execFileSync(rx.adapter, ['spans', field, value], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.trim() || '[]');
}

/** Run `fn` until it passes or SETTLE_MS is over; the last outcome is the result. */
async function settle(fn) {
  const deadline = Date.now() + SETTLE_MS;
  for (;;) {
    try {
      return { ok: true, detail: await fn() };
    } catch (error) {
      if (error instanceof Skip) return { ok: 'skip', detail: error.message };
      if (!(error instanceof Problem) || Date.now() >= deadline) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) };
      }
      await sleep(2000);
    }
  }
}

function print(label, outcome) {
  const verdict = outcome.ok === 'skip' ? 'SKIP' : outcome.ok ? 'PASS' : 'FAIL';
  console.log(`${verdict} ${label}: ${String(outcome.detail).replace(/\s+/g, ' ').trim()}`);
}

const trailer = (message, name) => new RegExp(`^${name}: (.+)$`, 'm').exec(message)?.[1];

function commitFacts(commit) {
  const run = /^([^;]+); trace=([0-9a-f]{32})$/.exec(trailer(commit.message, 'Factory-Run') ?? '');
  return {
    workUnit: trailer(commit.message, 'Work-Unit'),
    runId: run?.[1],
    traceId: run?.[2],
    digest: trailer(commit.message, 'Factory-Attestation'),
  };
}

// --- 1. trailers -------------------------------------------------------------
function checkTrailers() {
  const notes = [];
  for (const commit of state.commits) {
    const facts = commitFacts(commit);
    need(facts.workUnit === state.workId, `${commit.sha.slice(0, 8)}: Work-Unit "${facts.workUnit}" ≠ ${state.workId}`);
    need(facts.runId && facts.traceId, `${commit.sha.slice(0, 8)}: no "Factory-Run: R; trace=T" trailer`);
    need(facts.traceId === traceIdOf(facts.runId), `${commit.sha.slice(0, 8)}: trace ${facts.traceId} ≠ sha256("factory-run:"+R)[:32]`);
    need(/^sha256:[0-9a-f]{64}$/.test(facts.digest ?? ''), `${commit.sha.slice(0, 8)}: no Factory-Attestation: sha256:D trailer`);
    notes.push(`${commit.sha.slice(0, 8)} R=${facts.runId.slice(0, 8)} T=${facts.traceId.slice(0, 8)}`);
  }
  need(new Set(state.commits.map((c) => commitFacts(c).runId)).size === state.commits.length, 'two commits share a factory run');
  return `${state.commits.length} commits carry Work-Unit, Factory-Run (trace = derived) and Factory-Attestation (${notes.join(', ')})`;
}

// --- 2. work unit view ---------------------------------------------------------
async function checkView(rx) {
  const view = await workUnitView(rx);
  need(view.workUnit?.workUnitId === state.workId, `work unit ${state.workId} not returned`);
  need(view.attempts?.length === 1, `${view.attempts?.length} attempts, want 1`);
  const [attempt] = view.attempts;
  need(attempt.endedAt, 'attempt not ended after complete');
  const runIds = state.commits.map((commit) => commitFacts(commit).runId);
  need(attempt.factoryRuns.length === runIds.length, `${attempt.factoryRuns.length} factory runs, want ${runIds.length}`);
  for (const runId of runIds) {
    const run = attempt.factoryRuns.find((entry) => entry.factoryRunId === runId);
    need(run, `factory run ${runId} missing`);
    need(run.verdict === 'pass', `run ${runId.slice(0, 8)} verdict ${run.verdict}`);
    const stages = run.stages.map((stage) => `${stage.stageId}:${stage.status}`);
    need(JSON.stringify(stages) === JSON.stringify(STAGES.map((id) => `${id}:passed`)), `run ${runId.slice(0, 8)} stages ${stages.join(',')}`);
  }
  const sessions = Object.entries(state.sessions).map(([tool, id]) => attempt.sessions.find((s) => s.agentTool === tool && s.sessionId === id));
  need(sessions.every(Boolean), `session segments ${JSON.stringify(attempt.sessions.map((s) => `${s.agentTool}:${s.sessionId}`))}`);
  need(sessions.every((segment) => segment.to && Date.parse(segment.to) <= Date.parse(attempt.endedAt)), 'a session segment is still open after complete');
  return `1 attempt (ended), ${runIds.length} factory runs, stages ${STAGES.join('+')} passed, ${sessions.length} session segments closed`;
}

// --- 3. evidence -------------------------------------------------------------
async function proofStatement(rx, digest) {
  const proof = await read(rx, `v2/proofs/${digest}`);
  const payload = Buffer.from(proof.envelope.payload, 'base64');
  return { proof, payload, statement: JSON.parse(payload.toString('utf8')) };
}

async function checkEvidence(rx) {
  const view = await workUnitView(rx);
  const runs = view.attempts?.[0]?.factoryRuns ?? [];
  let files = 0;
  for (const [index, commit] of state.commits.entries()) {
    const facts = commitFacts(commit);
    const run = runs.find((entry) => entry.factoryRunId === facts.runId);
    need(run, `factory run ${facts.runId} missing`);
    const { statement } = await proofStatement(rx, facts.digest);
    const listed = (stageId) => statement.predicate?.stages?.find((stage) => stage.id === stageId)?.artifacts ?? [];
    for (const stage of run.stages) {
      need(stage.log?.stored, `${stage.stageId} log not stored`);
      const bytes = await read(rx, `v2/evidence/${stage.log.sha256}`, 'bytes');
      need(sha256(bytes) === stage.log.sha256, `${stage.stageId} log bytes do not hash to ${stage.log.sha256}`);
      need(bytes.length <= MIB, `${stage.stageId} log is ${bytes.length} bytes (> 1 MiB)`);
      need(listed(stage.stageId).some((a) => a.digest?.sha256 === stage.log.sha256), `${stage.stageId} log digest not in the proof's stages[].artifacts[]`);
      if (stage.stageId === 'big-output') {
        const first = bytes.subarray(0, 200).toString('utf8').split('\n')[0];
        need(DROPPED_LINE.test(first), `big-output log starts with "${first.slice(0, 60)}", not the dropped-bytes line`);
      }
      files += 1;
    }
    const writer = run.stages.find((stage) => stage.stageId === 'write-artifact');
    const report = writer?.artifacts.find((artifact) => artifact.name === 'fixture-report/report.json');
    need(report?.stored, `run ${facts.runId.slice(0, 8)}: fixture-report/report.json not stored`);
    const bytes = await read(rx, `v2/evidence/${report.sha256}`, 'bytes');
    const expected = `{"greeting":"${state.greetings[index]}"}\n`;
    need(bytes.toString('utf8') === expected, `report.json content ${JSON.stringify(bytes.toString('utf8'))}`);
    need(sha256(bytes) === report.sha256, 'report.json bytes do not hash to their digest');
    need(listed('write-artifact').some((a) => a.digest?.sha256 === report.sha256), 'report.json digest not in the proof');
    files += 1;
  }
  return `${files} files stored, each ≤ 1 MiB and hashing to the digest in the proof; big-output log starts with the dropped-bytes line`;
}

// --- 4. proof ------------------------------------------------------------------
async function checkProof(rx) {
  const view = await workUnitView(rx);
  const runs = view.attempts?.[0]?.factoryRuns ?? [];
  for (const commit of state.commits) {
    const facts = commitFacts(commit);
    const { proof, payload } = await proofStatement(rx, facts.digest);
    need(proof.statementDigest === facts.digest, `stored under ${proof.statementDigest}, trailer says ${facts.digest}`);
    need(`sha256:${sha256(payload)}` === facts.digest, 'envelope payload does not hash to D');
    need(proof.tree === commit.tree, `proof tree ${proof.tree} ≠ commit tree ${commit.tree}`);
    need(proof.factoryRunId === facts.runId, `proof names run ${proof.factoryRunId}, trailer ${facts.runId}`);
    need(proof.commits?.some((c) => c.commitSha === commit.sha), `proof lists no commit ${commit.sha.slice(0, 8)}`);
    const run = runs.find((entry) => entry.factoryRunId === facts.runId);
    const bound = run?.commits?.find((c) => c.commitSha === commit.sha);
    need(bound, `commit ${commit.sha.slice(0, 8)} not bound to run ${facts.runId.slice(0, 8)}`);
    need(bound.tree === commit.tree && bound.proofDigest === facts.digest, `binding of ${commit.sha.slice(0, 8)}: tree ${bound.tree}, proof ${bound.proofDigest}`);
    need(run.proof?.received === true && run.proof?.statementDigest === facts.digest, `run ${facts.runId.slice(0, 8)} proof not received`);
  }
  return `${state.commits.length} proofs stored under D (payload hashes to D), tree = commit tree, commit → run → proof bound`;
}

// --- 5. agent stamping ---------------------------------------------------------
function attributeOf(span, key) {
  return span.attributes?.[key] ?? span.resource?.[key];
}

// otel-hook stamps a span with the segment in force when it emits the span, at
// its end: the tool call that runs `har env launch` (or `work-bind`) starts before
// the attempt and ends inside it, and belongs to it. Spans are bucketed by their
// end time when the receiver keeps it, else by their start.
function classifyStamps(list) {
  const counts = { before: 0, inside: 0, after: 0 };
  const wrong = [];
  for (const { span, tool } of list) {
    const at = Date.parse(span.endTime ?? span.startTime);
    const opened = Date.parse(tool === 'codex' ? state.times.codexJoin : state.times.launch);
    const closed = Date.parse(state.times.complete);
    const attempt = attributeOf(span, 'factory.attempt.id');
    const bucket = at < opened ? 'before' : at < closed ? 'inside' : 'after';
    counts[bucket] += 1;
    const ok = bucket === 'inside' ? attempt === state.attemptId : attempt === undefined || attempt === null;
    if (!ok) wrong.push(`${tool} "${span.name}" ${span.startTime}..${span.endTime ?? '?'} (${bucket}) attempt=${attempt ?? 'none'}`);
  }
  need(wrong.length === 0, `${wrong.length} spans stamped wrongly: ${wrong.slice(0, 3).join('; ')}`);
  need(counts.before > 0 && counts.inside > 0 && counts.after > 0, `spans before/inside/after the attempt: ${JSON.stringify(counts)}`);
  return `agent spans before launch ${counts.before} unstamped, inside ${counts.inside} stamped with the attempt, after complete ${counts.after} unstamped`;
}

async function checkStamping(name) {
  const list = [];
  if (name === 'collector') {
    for (const span of collectorSpans()) {
      const sessionId = attributeOf(span, 'session.id');
      const tool = Object.entries(state.sessions).find(([, id]) => id === sessionId)?.[0];
      if (tool) list.push({ span, tool });
    }
  } else {
    const rx = receiver(name);
    for (const [tool, id] of Object.entries(state.sessions)) {
      for (const span of spans(rx, 'session', id)) list.push({ span, tool });
    }
  }
  return classifyStamps(list);
}

// --- 6. verification trace -------------------------------------------------------
async function checkVerificationTrace(name) {
  const notes = [];
  for (const commit of state.commits) {
    const facts = commitFacts(commit);
    const list = name === 'collector' ? collectorSpans().filter((span) => span.traceId === facts.traceId) : spans(receiver(name), 'trace', facts.traceId);
    const roots = list.filter((span) => attributeOf(span, 'factory.run.id') === facts.runId);
    need(roots.length === 1, `trace ${facts.traceId.slice(0, 8)}: ${roots.length} spans with factory.run.id = ${facts.runId.slice(0, 8)}`);
    const children = list.filter((span) => span.parentSpanId === roots[0].spanId);
    const names = children.map((span) => attributeOf(span, 'cicd.pipeline.task.name') ?? span.name).sort();
    need(JSON.stringify(names) === JSON.stringify([...STAGES].sort()), `trace ${facts.traceId.slice(0, 8)} stage spans: ${names.join(',') || 'none'}`);
    notes.push(facts.traceId.slice(0, 8));
  }
  return `traces ${notes.join(', ')}: one run span with factory.run.id = R, one span per stage`;
}

// --- 7. usage ------------------------------------------------------------------
async function attemptUsage(rx) {
  const view = await workUnitView(rx);
  return view.attempts?.[0]?.usage;
}

function expectedCodex() {
  // otel-hook reports Codex running totals; a receiver books the turn deltas.
  let previous = { input: 0, cached: 0, output: 0 };
  const total = { tokensInput: 0, tokensCacheRead: 0, tokensOutput: 0 };
  for (const turn of state.codexTurns) {
    const delta = { input: turn.input - previous.input, cached: turn.cached - previous.cached, output: turn.output - previous.output };
    total.tokensInput += delta.input - delta.cached;
    total.tokensCacheRead += delta.cached;
    total.tokensOutput += delta.output;
    previous = turn;
  }
  return total;
}

/** Expected Claude Code usage per model: one generation per turn and one per subagent run (otel-hook#68). */
function expectedClaude() {
  const byModel = new Map();
  for (const generation of state.claudeGenerations) {
    const row = byModel.get(generation.model) ?? { observations: 0, tokensInput: 0, tokensOutput: 0, tokensCacheRead: 0, tokensCacheCreation: 0 };
    row.observations += 1;
    row.tokensInput += generation.input;
    row.tokensOutput += generation.output;
    row.tokensCacheRead += generation.cacheRead;
    row.tokensCacheCreation += generation.cacheCreation;
    byModel.set(generation.model, row);
  }
  return byModel;
}

/** Claude Code usage booked once per generation, fresh input = input - cache, priced by the receiver. */
function checkClaudeRows(usage) {
  const rows = usage.byModel.filter((row) => row.agentTool === 'claude_code');
  const want = expectedClaude();
  need(rows.length === want.size, `claude_code rows ${JSON.stringify(rows.map((r) => r.model))}, want ${JSON.stringify([...want.keys()])}`);
  for (const [model, expected] of want) {
    const row = rows.find((entry) => entry.model === model);
    need(row, `no claude_code/${model} row`);
    need(row.observations === expected.observations, `claude_code/${model}: ${row.observations} observations for ${expected.observations} generations (double counted?)`);
    for (const key of ['tokensInput', 'tokensOutput', 'tokensCacheRead', 'tokensCacheCreation']) {
      need(row[key] === expected[key], `claude_code/${model} ${key} ${row[key]} ≠ ${expected[key]}`);
    }
    need(row.costUsd > 0 && row.costSource === 'estimated', `claude_code/${model} cost ${row.costUsd} (${row.costSource}), want a receiver estimate`);
    need(row.pricedWith?.length > 0 && row.pricedWith.every((v) => /genai-prices/.test(v)), `claude_code/${model} priced with ${JSON.stringify(row.pricedWith)}`);
  }
  return rows;
}

/** The Collector keeps what otel-hook sent: each Claude Code generation span once, with its tokens. */
function checkCollectorUsage() {
  // The attempt's generations: a session may go on after complete (outside the attempt).
  const generations = collectorSpans().filter(
    (span) =>
      /^generation( |$)/.test(span.name) &&
      (span.attributes['otelhook.session.id'] ?? span.attributes['gen_ai.conversation.id']) === state.sessions.claude_code &&
      attributeOf(span, 'factory.attempt.id') === state.attemptId,
  );
  const byId = new Map();
  for (const span of generations) {
    const id = span.attributes['otelhook.generation.id'];
    need(id, `generation span ${span.spanId} without otelhook.generation.id`);
    byId.set(id, [...(byId.get(id) ?? []), span]);
  }
  const twice = [...byId].filter(([, list]) => list.length > 1).map(([id]) => id);
  need(twice.length === 0, `generation ids exported more than once: ${twice.join(', ')}`);
  need(byId.size === state.claudeGenerations.length, `${byId.size} Claude Code generation spans, want ${state.claudeGenerations.length}`);
  const sum = (key) => generations.reduce((total, span) => total + Number(span.attributes[key] ?? 0), 0);
  const want = state.claudeGenerations.reduce((total, g) => total + g.input + g.cacheRead + g.cacheCreation, 0);
  need(sum('gen_ai.usage.input_tokens') === want, `gen_ai.usage.input_tokens ${sum('gen_ai.usage.input_tokens')} ≠ ${want} (input includes cache)`);
  const subagents = generations.filter((span) => span.attributes['otelhook.subagent.id']).length;
  need(subagents === state.claudeGenerations.filter((g) => g.subagent).length, `${subagents} subagent generations`);
  return `claude_code ${byId.size} generation spans once each (${subagents} subagent), input tokens ${want} incl. cache`;
}

async function checkUsage(name) {
  if (name === 'collector') return checkCollectorUsage();
  const rx = receiver(name);
  const usage = await attemptUsage(rx);
  need(usage, 'no usage on the attempt');
  if (!state.sessions.codex) {
    const claude = checkClaudeRows(usage);
    return `${claude.map((row) => `claude_code/${row.model} ${row.observations} generations $${row.costUsd.toFixed(6)}`).join(', ')}, from otel-hook, booked once (no codex session)`;
  }
  const codex = usage.byModel.find((row) => row.agentTool === 'codex' && row.model === state.codexModel);
  const want = expectedCodex();
  need(codex, `no codex/${state.codexModel} usage (got ${JSON.stringify(usage.byModel.map((r) => `${r.agentTool}/${r.model}`))})`);
  for (const key of Object.keys(want)) need(codex[key] === want[key], `codex ${key} ${codex[key]} ≠ ${want[key]}`);
  need(codex.observations === state.codexTurns.length, `codex: ${codex.observations} observations, want ${state.codexTurns.length}`);
  need(codex.costUsd > 0 && codex.costSource === 'estimated', `codex cost ${codex.costUsd} (${codex.costSource}), want a receiver estimate`);
  need(codex.pricedWith?.length > 0 && codex.pricedWith.every((v) => /genai-prices/.test(v)), `codex priced with ${JSON.stringify(codex.pricedWith)}`);
  const claude = checkClaudeRows(usage);
  const claudeNote = claude.map((row) => `claude_code/${row.model} ${row.observations} generations $${row.costUsd.toFixed(6)}`).join(', ');
  return `codex/${state.codexModel} ${codex.observations} turns $${codex.costUsd.toFixed(6)} priced with ${codex.pricedWith.join(',')}; ${claudeNote}, from otel-hook, booked once`;
}

async function checkUsageAgree() {
  const rows = [];
  for (const rx of state.receivers) {
    const usage = await attemptUsage(rx);
    const booked = (usage?.byModel ?? []).filter((row) => row.agentTool === 'codex' || row.agentTool === 'claude_code');
    need(!state.sessions.codex || booked.some((row) => row.agentTool === 'codex' && row.model === state.codexModel), `${rx.name}: no codex usage`);
    rows.push({ name: rx.name, booked });
  }
  const [a, b] = rows;
  need(rows.length === 2, 'needs two receivers');
  const key = (row) => `${row.agentTool}/${row.model}`;
  need(JSON.stringify(a.booked.map(key).sort()) === JSON.stringify(b.booked.map(key).sort()), `rows: ${a.name} ${a.booked.map(key)} ≠ ${b.name} ${b.booked.map(key)}`);
  for (const left of a.booked) {
    const right = b.booked.find((row) => key(row) === key(left));
    for (const field of ['tokensInput', 'tokensOutput', 'tokensCacheRead', 'tokensCacheCreation', 'observations']) {
      need(left[field] === right[field], `${key(left)} ${field}: ${a.name} ${left[field]} ≠ ${b.name} ${right[field]}`);
    }
    need(Math.abs(left.costUsd - right.costUsd) < 1e-9, `${key(left)} cost: ${a.name} ${left.costUsd} ≠ ${b.name} ${right.costUsd}`);
    need(JSON.stringify(left.pricedWith) === JSON.stringify(right.pricedWith), `${key(left)} priced with ${left.pricedWith} vs ${right.pricedWith}`);
  }
  return `${a.name} and ${b.name} book the same ${a.booked.length} rows (${a.booked.map(key).join(', ')}) at the same cost`;
}

// --- 13. trajectory ---------------------------------------------------------------
/**
 * The trajectory a receiver built from otel-hook's logs (ADR 0005 section 3),
 * through its adapter (`<adapter> trajectory session <id>`: a JSON array of
 * `{eventId, eventType, sequence, attributes}`, one per stored row).
 */
function trajectory(rx, sessionId) {
  let out;
  try {
    out = execFileSync(rx.adapter, ['trajectory', 'session', sessionId], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (error.status === 2 || error.status === 3) throw new Skip(`${rx.name} adapter has no trajectory reads`);
    throw error;
  }
  return JSON.parse(out.trim() || '[]');
}

function trajectoryEvents(rows) {
  // One stored row per content fact: an event may have several, never two events one id.
  const events = new Map();
  for (const row of rows) {
    const seen = events.get(row.eventId);
    need(!seen || (seen.eventType === row.eventType && seen.sequence === row.sequence), `event ${row.eventId} stored twice with different facts`);
    events.set(row.eventId, row);
  }
  const ordered = [...events.values()].sort((left, right) => left.sequence - right.sequence);
  const sequences = ordered.map((event) => event.sequence);
  need(new Set(sequences).size === sequences.length, `two events share a sequence: ${sequences.join(',')}`);
  return ordered;
}

async function checkTrajectory(name) {
  const rx = receiver(name);
  const claude = trajectoryEvents(trajectory(rx, state.sessions.claude_code));
  const count = (type) => claude.filter((event) => event.eventType === type).length;
  // Events before launch carry no work identity: Mission Control places them by
  // workspace path, a hosted receiver (no local paths) may have no repository for
  // them. What happened inside the attempt must be there, in order.
  const start = claude.findIndex((event) => event.eventType === 'session.start');
  need(start <= 0, `session.start is not the first event (index ${start})`);
  const turns = state.claudeGenerations.filter((g) => !g.subagent).length;
  // Replayed: one prompt per turn. Real: a turn may run without a prompt of its
  // own, and the first prompt comes before launch; the receiver must hold at
  // least the prompts the Collector holds stamped with the attempt.
  const wantPrompts = state.realAgents ? collectorLogs().filter((r) => r.attributes['otelhook.event.type'] === 'prompt.submitted' && r.attributes['otelhook.session.id'] === state.sessions.claude_code && r.attributes['factory.attempt.id'] === state.attemptId).length : turns;
  need(count('prompt.submitted') >= wantPrompts, `${count('prompt.submitted')} prompts, want at least ${wantPrompts}`);
  // Tool calls pair by call id; a subagent nests its own tool calls under its id.
  const starts = claude.filter((event) => event.eventType === 'tool.start');
  const ends = claude.filter((event) => event.eventType === 'tool.end');
  const callId = (event) => event.attributes['gen_ai.tool.call_id'] ?? event.attributes['gen_ai.tool.call.id'];
  // A call still running (a start with no end yet) is fine; an end with no start is not.
  const paired = starts.filter((start) => ends.some((end) => callId(end) && callId(end) === callId(start)));
  // A receiver that does not place events before launch misses the start of the
  // tool call that ran the launch (it ends inside the attempt): an end may lack
  // its start only when the Collector holds that start unstamped.
  const unplaced = new Set(
    start === -1
      ? collectorLogs()
          .filter((r) => r.attributes['otelhook.event.type'] === 'tool.start' && r.attributes['otelhook.session.id'] === state.sessions.claude_code && !r.attributes['factory.attempt.id'])
          .map((r) => r.attributes['gen_ai.tool.call_id'] ?? r.attributes['gen_ai.tool.call.id'])
      : [],
  );
  const orphans = ends.filter((end) => !starts.some((start) => callId(start) === callId(end)));
  need(orphans.every((end) => unplaced.has(callId(end))), `tool ends without a start (${orphans.length} of ${ends.length} ends)`);
  // Each replayed turn (and the real task) runs an edit, an Agent call and a nested Read.
  const wantPairs = state.realAgents ? 3 : turns * 3;
  need(paired.length >= wantPairs, `${paired.length} paired tool calls, want ${wantPairs} (edit, Agent, nested Read per turn)`);
  const subagentIds = state.claudeGenerations.filter((g) => g.subagent).map((g) => g.subagent);
  for (const id of subagentIds) {
    const inside = claude.filter((event) => event.attributes['otelhook.subagent.id'] === id);
    const types = inside.map((event) => event.eventType);
    need(types.includes('subagent.start') && types.includes('subagent.end'), `subagent ${id}: ${types.join(',') || 'no records'}`);
    need(types.filter((type) => type.startsWith('tool.')).length >= 2, `subagent ${id}: no nested tool call (${types.join(',')})`);
    const [first, last] = [inside.find((e) => e.eventType === 'subagent.start'), inside.find((e) => e.eventType === 'subagent.end')];
    need(first.sequence < last.sequence, `subagent ${id} ends before it starts`);
  }
  const codex = state.sessions.codex ? trajectoryEvents(trajectory(rx, state.sessions.codex)) : [];
  need(!state.sessions.codex || codex.some((event) => event.eventType === 'prompt.submitted'), 'codex trajectory has no prompt');
  return `claude_code ${claude.length} events in sequence order${start === 0 ? ' from session.start' : ' (pre-launch events not placed)'} (${paired.length} paired tool calls, ${subagentIds.length} subagents with nested calls), codex ${codex.length} events; each event id once`;
}

// --- 10. collector ---------------------------------------------------------------
function otlpValue(value) {
  if (!value) return undefined;
  if ('stringValue' in value) return value.stringValue;
  if ('intValue' in value) return Number(value.intValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('boolValue' in value) return value.boolValue;
  return JSON.stringify(value);
}
const attrMap = (list) => Object.fromEntries((list ?? []).map((entry) => [entry.key, otlpValue(entry.value)]));

function collectorLines(signal) {
  const file = path.join(state.collectorDir, `${signal}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function collectorSpans() {
  const out = [];
  for (const batch of collectorLines('traces')) {
    for (const rs of batch.resourceSpans ?? []) {
      const resource = attrMap(rs.resource?.attributes);
      for (const ss of rs.scopeSpans ?? []) {
        for (const span of ss.spans ?? []) {
          out.push({
            traceId: span.traceId,
            spanId: span.spanId,
            parentSpanId: span.parentSpanId || null,
            name: span.name,
            startTime: new Date(Number(BigInt(span.startTimeUnixNano) / 1_000_000n)).toISOString(),
            ...(span.endTimeUnixNano ? { endTime: new Date(Number(BigInt(span.endTimeUnixNano) / 1_000_000n)).toISOString() } : {}),
            attributes: attrMap(span.attributes),
            resource,
          });
        }
      }
    }
  }
  return out;
}

function collectorLogs() {
  const logs = [];
  for (const batch of collectorLines('logs')) {
    for (const rl of batch.resourceLogs ?? []) {
      const resource = attrMap(rl.resource?.attributes);
      for (const sl of rl.scopeLogs ?? []) for (const record of sl.logRecords ?? []) logs.push({ attributes: attrMap(record.attributes), resource });
    }
  }
  return logs;
}

function checkCollector() {
  const stamped = (records) => records.filter((r) => r.attributes['factory.attempt.id'] === state.attemptId || r.resource['factory.attempt.id'] === state.attemptId).length;
  const spanList = collectorSpans();
  const logs = collectorLogs();
  const points = [];
  for (const batch of collectorLines('metrics')) {
    for (const rm of batch.resourceMetrics ?? []) {
      const resource = attrMap(rm.resource?.attributes);
      for (const sm of rm.scopeMetrics ?? []) {
        for (const metric of sm.metrics ?? []) {
          const data = metric.sum ?? metric.gauge ?? metric.histogram ?? metric.exponentialHistogram ?? {};
          for (const point of data.dataPoints ?? []) points.push({ attributes: attrMap(point.attributes), resource });
        }
      }
    }
  }
  const counts = { spans: stamped(spanList), logs: stamped(logs), metrics: stamped(points) };
  need(counts.spans > 0 && counts.logs > 0 && counts.metrics > 0, `stamped records: ${JSON.stringify(counts)} (of ${spanList.length} spans, ${logs.length} logs, ${points.length} points)`);
  const leaks = ['traces', 'logs', 'metrics'].filter((signal) => {
    const file = path.join(state.collectorDir, `${signal}.jsonl`);
    return fs.existsSync(file) && fs.readFileSync(file, 'utf8').includes('"factory.local.');
  });
  need(leaks.length === 0, `factory.local.* found in ${leaks.join(', ')}`);
  // Claude Code usage comes from otel-hook only: no native Claude Code telemetry.
  const native = ['traces', 'logs', 'metrics'].filter((signal) => {
    const file = path.join(state.collectorDir, `${signal}.jsonl`);
    return fs.existsSync(file) && /"(?:name|stringValue)":"claude_code\./.test(fs.readFileSync(file, 'utf8'));
  });
  need(native.length === 0, `native Claude Code telemetry (claude_code.*) found in ${native.join(', ')}`);
  return `stamped spans ${counts.spans}, logs ${counts.logs}, metric points ${counts.metrics}; no factory.local.* key; no claude_code.* (native) telemetry`;
}

// --- 14. what the real agents reported (run.sh --real-agents) ----------------------
/**
 * Claude Code's own report (`claude -p --output-format json`: modelUsage per model,
 * total_cost_usd) against the generations otel-hook exported for the session
 * (Collector, every generation once, inside and outside the attempt): tokens
 * must be equal per model (otel-hook reads the transcripts Claude Code bills
 * from). A model Claude Code reports that no transcript holds is listed.
 */
function checkAgentReport() {
  const reports = state.realAgents?.claudeReports ?? [];
  need(reports.length > 0, 'no Claude Code report in the state (run.sh --real-agents)');
  // `claude -p --resume` reports the session's running total: per session, the
  // last report covers every run of it.
  const last = new Map();
  for (const report of reports) last.set(report.session_id, report);
  const reported = new Map();
  let reportedCost = 0;
  for (const report of last.values()) {
    reportedCost += report.total_cost_usd ?? 0;
    for (const [model, u] of Object.entries(report.modelUsage ?? {})) {
      const row = reported.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0 };
      row.input += u.inputTokens ?? 0;
      row.output += u.outputTokens ?? 0;
      row.cacheRead += u.cacheReadInputTokens ?? 0;
      row.cacheCreation += u.cacheCreationInputTokens ?? 0;
      row.cost += u.costUSD ?? 0;
      reported.set(model, row);
    }
  }
  const exported = new Map();
  const seen = new Set();
  for (const span of collectorSpans()) {
    const a = span.attributes;
    if (!/^generation( |$)/.test(span.name) || a['otelhook.session.id'] !== state.sessions.claude_code || seen.has(a['otelhook.generation.id'])) continue;
    seen.add(a['otelhook.generation.id']);
    const model = a['gen_ai.response.model'] ?? a['gen_ai.request.model'];
    const row = exported.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, generations: 0 };
    const cacheRead = Number(a['gen_ai.usage.cache_read.input_tokens'] ?? 0);
    const cacheCreation = Number(a['gen_ai.usage.cache_creation.input_tokens'] ?? 0);
    row.input += Number(a['gen_ai.usage.input_tokens'] ?? 0) - cacheRead - cacheCreation;
    row.output += Number(a['gen_ai.usage.output_tokens'] ?? 0);
    row.cacheRead += cacheRead;
    row.cacheCreation += cacheCreation;
    row.generations += 1;
    exported.set(model, row);
  }
  need(exported.size > 0, 'otel-hook exported no Claude Code generation');
  const notes = [];
  const over = [];
  for (const [model, got] of exported) {
    const want = reported.get(model);
    need(want, `otel-hook model ${model} not in Claude Code's report (${[...reported.keys()].join(', ')})`);
    const delta = Object.fromEntries(['input', 'output', 'cacheRead', 'cacheCreation'].map((key) => [key, got[key] - want[key]]));
    for (const [key, value] of Object.entries(delta)) if (value !== 0) over.push(`${model} ${key} ${value > 0 ? '+' : ''}${value}`);
    notes.push(
      `${model}: ${got.generations} generations, otel-hook in/out/cacheRead/cacheWrite ${got.input}/${got.output}/${got.cacheRead}/${got.cacheCreation} vs reported ${want.input}/${want.output}/${want.cacheRead}/${want.cacheCreation} (delta ${Object.values(delta).join('/')}), reported $${want.cost.toFixed(6)}`,
    );
  }
  const unseen = [...reported.keys()].filter((model) => !exported.has(model));
  if (unseen.length) notes.push(`reported but not in a transcript: ${unseen.map((m) => `${m} $${reported.get(m).cost.toFixed(6)}`).join(', ')}`);
  need(over.length === 0, `otel-hook and Claude Code's own report differ: ${over.join(', ')}; ${notes.join('; ')}`);
  return `${reports.length} claude -p runs (${last.size} session), reported total $${reportedCost.toFixed(6)}; ${notes.join('; ')}`;
}

// --- probes for run.sh's composite checks (8, 9) -----------------------------------
/** probe-received <receiver> <work-id> <commit-sha>... : runs, stages, logs, proofs, commit bindings, once each. */
async function probeReceived(name, workId, shas) {
  const rx = receiver(name);
  const view = await workUnitView(rx, workId);
  const runs = view.attempts.flatMap((attempt) => attempt.factoryRuns);
  for (const sha of shas) {
    const runsWithCommit = runs.filter((run) => run.commits.some((c) => c.commitSha === sha));
    need(runsWithCommit.length === 1, `${name}: commit ${sha.slice(0, 8)} bound to ${runsWithCommit.length} runs`);
    const [run] = runsWithCommit;
    need(run.commits.filter((c) => c.commitSha === sha).length === 1, `${name}: commit ${sha.slice(0, 8)} bound twice`);
    need(run.proof?.received, `${name}: run ${run.factoryRunId.slice(0, 8)} proof not received`);
    need(run.stages.length === STAGES.length && run.stages.every((s) => s.status === 'passed' && s.log?.stored), `${name}: run ${run.factoryRunId.slice(0, 8)} stages/logs ${JSON.stringify(run.stages.map((s) => [s.stageId, s.status, s.log?.stored]))}`);
    const traced = spans(rx, 'trace', run.traceId);
    need(traced.length === STAGES.length + 1, `${name}: trace ${run.traceId.slice(0, 8)} has ${traced.length} spans, want ${STAGES.length + 1}`);
  }
  need(runs.length === shas.length, `${name}: ${runs.length} factory runs for ${shas.length} commits`);
  return `${name}: ${shas.length} runs, each once, with proof, ${STAGES.length} stage logs and ${STAGES.length + 1} spans`;
}

async function probeUsageCount(name, workId, model, count) {
  const view = await workUnitView(receiver(name), workId);
  const rows = view.attempts.flatMap((attempt) => attempt.usage.byModel).filter((row) => row.agentTool === 'codex' && row.model === model);
  const observations = rows.reduce((total, row) => total + row.observations, 0);
  need(observations === Number(count), `${name}: ${observations} codex observations, want ${count}`);
  return `${name}: ${observations} codex observations`;
}

async function main() {
  const label = (n, what) => `${n} ${what}${target ? ` @${target}` : ''}`;
  switch (command) {
    case 'trailers':
      return print('1 trailers', await settle(() => checkTrailers()));
    case 'view':
      return print(label(2, 'work-unit-view'), await settle(() => checkView(receiver(target))));
    case 'evidence':
      return print(label(3, 'evidence'), await settle(() => checkEvidence(receiver(target))));
    case 'proof':
      return print(label(4, 'proof'), await settle(() => checkProof(receiver(target))));
    case 'stamping':
      return print(label(5, 'agent-stamping'), await settle(() => checkStamping(target)));
    case 'vtrace':
      return print(label(6, 'verification-trace'), await settle(() => checkVerificationTrace(target)));
    case 'usage':
      return print(label(7, 'usage'), await settle(() => checkUsage(target)));
    case 'usage-agree':
      return print('7 usage-agree', await settle(() => checkUsageAgree()));
    case 'collector':
      return print('10 collector', await settle(() => checkCollector()));
    case 'agent-report':
      return print('14 agent-report', await settle(() => checkAgentReport()));
    case 'trajectory':
      return print(label(13, 'trajectory'), await settle(() => checkTrajectory(target)));
    case 'probe-received':
    case 'probe-usage': {
      const outcome = await settle(() =>
        command === 'probe-received' ? probeReceived(target, rest[0], rest.slice(1)) : probeUsageCount(target, rest[0], rest[1], rest[2]),
      );
      console.log(outcome.detail);
      process.exit(outcome.ok ? 0 : 1);
    }
    default:
      throw new Error(`unknown check ${command}`);
  }
}

await main();
