#!/usr/bin/env node
// Helper of fixture-e2e.sh (no dependencies; Node >= 20).
//
//   overlay   <stages.patch.json> <.har dir>        apply the fixture's verify stages
//   committed <url> <work-id> <repo-url> <session> <commit-sha> <message-file>
//   completed <url> <work-id> <repo-url> <session>
//
// `committed` and `completed` read Mission Control's work unit view
// (GET /api/v2/work-units/{id}) and fail with one line per broken expectation.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MIB = 1024 * 1024;
const [command, ...args] = process.argv.slice(2);
const problems = [];

function check(condition, message) {
  if (!condition) problems.push(message);
  return Boolean(condition);
}

function done(label) {
  if (problems.length) {
    console.error(`fixture-e2e: ${label}: ${problems.length} check(s) failed`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.error(`fixture-e2e: ${label}: ok`);
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function getBytes(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url}: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function workUnitView(base, workId, repoUrl) {
  return getJson(`${base}/api/v2/work-units/${encodeURIComponent(workId)}?repository=${encodeURIComponent(repoUrl)}`);
}

function overlay(patchFile, harnessDir) {
  const patch = JSON.parse(fs.readFileSync(patchFile, 'utf8'));
  const stagesFile = path.join(harnessDir, 'stages.json');
  const registry = JSON.parse(fs.readFileSync(stagesFile, 'utf8'));
  // The fixture's verify is exactly its own stages: the profile's npm stages have nothing to run.
  const dropped = new Set(registry.verificationStages);
  const ids = new Set(patch.stages.map((stage) => stage.id));
  registry.stages = registry.stages.filter((stage) => !dropped.has(stage.id) && !ids.has(stage.id)).concat(patch.stages);
  registry.verificationStages = patch.verificationStages;
  fs.writeFileSync(stagesFile, `${JSON.stringify(registry, null, 2)}\n`);
  for (const stage of dropped) {
    const script = path.join(harnessDir, 'stages', `${stage}.sh`);
    if (!ids.has(stage)) fs.rmSync(script, { force: true });
  }
  const envFile = path.join(harnessDir, 'harness.env');
  let env = fs.readFileSync(envFile, 'utf8');
  for (const [key, value] of Object.entries(patch.harnessEnv ?? {})) env += `export ${key}="${value}"\n`;
  fs.writeFileSync(envFile, env);
}

async function committed(base, workId, repoUrl, sessionId, commitSha, messageFile) {
  const view = await workUnitView(base, workId, repoUrl);
  const message = fs.readFileSync(messageFile, 'utf8');

  check(view.workUnit?.workUnitId === workId, `work unit ${workId} is returned`);
  check(view.workUnit?.repositoryUrl === repoUrl, `work unit is scoped to ${repoUrl} (got ${view.workUnit?.repositoryUrl})`);
  if (!check(view.attempts?.length === 1, `1 attempt (got ${view.attempts?.length})`)) return done('after commit');
  const [attempt] = view.attempts;
  check(attempt.endedAt === null, 'the attempt is not ended before complete');

  const segments = attempt.sessions.filter((segment) => segment.sessionId === sessionId);
  check(
    segments.length === 1 && segments[0].agentTool === 'claude_code' && segments[0].to === null,
    `one open claude_code session segment for ${sessionId} (got ${JSON.stringify(attempt.sessions)})`,
  );

  if (!check(attempt.factoryRuns?.length === 1, `1 factory run (got ${attempt.factoryRuns?.length})`)) return done('after commit');
  const [run] = attempt.factoryRuns;
  const runId = run.factoryRunId;
  check(run.verdict === 'pass', `factory run verdict pass (got ${run.verdict})`);
  check(run.attemptId === attempt.attemptId, 'factory run belongs to the attempt');
  check(
    run.sessions.some((ref) => ref.agentTool === 'claude_code' && ref.sessionId === sessionId && ref.ranVerify === true),
    `factory run names the session that ran verify (got ${JSON.stringify(run.sessions)})`,
  );

  const expectedTrace = createHash('sha256').update(`factory-run:${runId}`).digest('hex').slice(0, 32);
  check(run.traceId === expectedTrace, `trace id is sha256("factory-run:"+R)[:32] = ${expectedTrace} (got ${run.traceId})`);

  const stages = new Map(run.stages.map((stage) => [stage.stageId, stage]));
  check(
    JSON.stringify([...stages.keys()]) === JSON.stringify(['big-output', 'write-artifact']),
    `stages big-output, write-artifact (got ${[...stages.keys()].join(', ')})`,
  );
  for (const stage of stages.values()) {
    check(stage.status === 'passed', `stage ${stage.stageId} passed (got ${stage.status})`);
    check(stage.addedBy === 'policy', `stage ${stage.stageId} added by policy (got ${stage.addedBy})`);
    check(stage.kind === 'test', `stage ${stage.stageId} kind test (got ${stage.kind})`);
  }

  // The proof: the commit's Factory-Attestation, stored by the receiver.
  const attestation = /^Factory-Attestation: (sha256:[0-9a-f]{64})$/m.exec(message)?.[1];
  check(attestation, `commit has a Factory-Attestation trailer:\n${message}`);
  check(run.proof?.statementDigest === attestation, `proof digest ${run.proof?.statementDigest} = Factory-Attestation ${attestation}`);
  check(run.proof?.received === true, 'the proof envelope was received');
  const trailerRun = /^Factory-Run: (.+)$/m.exec(message)?.[1];
  check(trailerRun === `${runId}; trace=${expectedTrace}`, `Factory-Run trailer "${runId}; trace=${expectedTrace}" (got "${trailerRun}")`);
  check(/^Work-Unit: fx-1$/m.test(message), 'Work-Unit trailer');

  let predicate = null;
  if (attestation) {
    const proof = await getJson(`${base}/api/v2/proofs/${attestation}`);
    check(proof.factoryRunId === runId, `proof names factory run ${runId}`);
    const statement = JSON.parse(Buffer.from(proof.envelope.payload, 'base64').toString('utf8'));
    check(sha256(Buffer.from(proof.envelope.payload, 'base64')) === attestation.slice('sha256:'.length), 'statement digest matches the envelope payload');
    predicate = statement.predicate;
    check(predicate?.telemetry?.traceId === undefined || predicate.telemetry.traceId === expectedTrace, 'predicate trace id');
  }
  const proofArtifacts = (stageId) => predicate?.stages?.find((stage) => stage.id === stageId)?.artifacts ?? [];

  // The capped log: stored, ≤ 1 MiB, starting with the dropped-bytes line, digest as in the proof.
  const big = stages.get('big-output');
  if (check(big?.log?.stored, 'big-output log is stored')) {
    const bytes = await getBytes(`${base}/api/v2/evidence/${big.log.sha256}`);
    check(sha256(bytes) === big.log.sha256, 'big-output log bytes hash to their digest');
    check(bytes.length <= MIB, `big-output log ≤ 1 MiB (got ${bytes.length})`);
    const first = bytes.subarray(0, 200).toString('utf8').split('\n')[0];
    check(/^\[har\] \d+ bytes dropped, last \d+ bytes kept$/.test(first), `big-output log starts with the dropped-bytes line (got "${first}")`);
    check(
      proofArtifacts('big-output').some((artifact) => artifact.digest?.sha256 === big.log.sha256),
      `proof stages[big-output].artifacts[] lists the log digest ${big.log.sha256} (got ${JSON.stringify(proofArtifacts('big-output'))})`,
    );
  }

  // The artifact file: stored, bytes as written, listed in the proof.
  const writer = stages.get('write-artifact');
  const report = writer?.artifacts.find((artifact) => artifact.name === 'fixture-report/report.json');
  if (check(report?.stored, `write-artifact's fixture-report/report.json is stored (got ${JSON.stringify(writer?.artifacts)})`)) {
    const bytes = await getBytes(`${base}/api/v2/evidence/${report.sha256}`);
    check(bytes.toString('utf8') === '{"greeting":"hello, factory"}\n', `artifact content (got ${JSON.stringify(bytes.toString('utf8'))})`);
    check(
      proofArtifacts('write-artifact').some((artifact) => artifact.digest?.sha256 === report.sha256),
      'proof stages[write-artifact].artifacts[] lists the artifact digest',
    );
  }
  check(writer?.log?.stored, 'write-artifact log is stored');

  // The commit, bound to the factory run and its proof.
  const commit = run.commits.find((entry) => entry.commitSha === commitSha);
  check(commit, `commit ${commitSha} is bound to factory run ${runId} (got ${JSON.stringify(run.commits)})`);
  check(commit?.tree === run.tree, 'bound commit tree = factory run tree');
  check(commit?.proofDigest === attestation, 'bound commit names the proof');

  done('after commit');
}

async function completed(base, workId, repoUrl, sessionId) {
  const view = await workUnitView(base, workId, repoUrl);
  if (!check(view.attempts?.length === 1, `1 attempt after complete (got ${view.attempts?.length})`)) return done('after complete');
  const [attempt] = view.attempts;
  check(attempt.endedAt, 'the attempt is ended');
  const segment = attempt.sessions.find((entry) => entry.sessionId === sessionId);
  check(segment?.to, `the session segment is closed (got ${JSON.stringify(segment)})`);
  if (segment?.to && attempt.endedAt) {
    check(Date.parse(segment.to) <= Date.parse(attempt.endedAt), 'the segment closes no later than the attempt ends');
  }
  check(attempt.factoryRuns?.length === 1, 'still 1 factory run');
  done('after complete');
}

try {
  if (command === 'overlay') overlay(args[0], args[1]);
  else if (command === 'committed') await committed(...args);
  else if (command === 'completed') await completed(...args);
  else throw new Error(`unknown command ${command}`);
} catch (error) {
  console.error(`fixture-e2e: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
