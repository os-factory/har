import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { applyLine } from '../src/harness/lines';
import { buildFactoryRunPredicate } from '../src/core/proof';
import { finalizeStageEvidence } from '../src/core/stage-evidence';
import { HarnessStageRegistrySchema } from '../src/harness/schema';
import {
  SessionContextLockError,
  closeSegmentsForOccupancy,
  endSlotOccupancySegments,
  rebindSlotSegments,
  setSessionContextLockOptions,
  computeSessionRefs,
  listSessionContexts,
  mergeSessionRefs,
  openSessionSegment,
  readSessionContextFile,
  recordLaunchSegment,
  sessionContextFile,
  slotRepositoryUrl,
  writeSessionContextFile,
} from '../src/core/session-context';
import { completeEnvironment, launchEnvironment, runVerification, teardownEnvironment } from '../src/core/run-service';
import { createWorkAttempt, findWorkAttempt, markWorkAttemptEnded, upsertWorkUnit } from '../src/core/work-units';
import { findValidation } from '../src/core/validations';
import { computeWorktreeSnapshot } from '../src/core/change-batch';
import { getSlotRegistryPath } from '../src/core/slot-registry';
import { segmentInForce, type SessionContext } from '../src/harness/schema';

/** ADR 0004 sections 2 and 4: session segments written by the CLI, session refs on the factory run. */

const RUNNER = path.join(__dirname, '..', 'src', 'templates', 'runtime-bundles', 'shared-kernel', 'lib', 'verify-runner.mjs');

const mockSlotEntry: { current: Record<string, unknown> | null } = { current: null };

jest.mock('../src/runtime', () => {
  const actual = jest.requireActual('../src/runtime');
  const fsMod = jest.requireActual('fs');
  const pathMod = jest.requireActual('path');
  return {
    ...actual,
    launchSession: jest.fn(
      async (options: { repoPath: string; agentId: number; workUnitId?: string; attemptId?: string }) => {
      const file = pathMod.join(options.repoPath, '.har', 'slots', `agent-${options.agentId}.json`);
      fsMod.mkdirSync(pathMod.dirname(file), { recursive: true });
      // Like launch.sh: the slot record carries the work binding it was launched with.
      fsMod.writeFileSync(
        file,
        JSON.stringify({ ...mockSlotEntry.current, workUnitId: options.workUnitId, attemptId: options.attemptId }),
      );
      return { code: 0 };
      },
    ),
    teardownSession: jest.fn(async (options: { repoPath: string; agentId: number }) => {
      fsMod.rmSync(pathMod.join(options.repoPath, '.har', 'slots', `agent-${options.agentId}.json`), { force: true });
      return { code: 0 };
    }),
    // The real stage runner, pointed at the temp repo; HAR_STAGE_LOG_DIR comes from the run service.
    buildVerifyPlan: jest.fn((repoPath: string, agentId: number, args: string[], env: NodeJS.ProcessEnv) => ({
      shellCommand: `exec node ${JSON.stringify(RUNNER)} --agent ${agentId}${args.includes('--full') ? ' --full' : ''}`,
      cwd: repoPath,
      env: { ...env, HAR_HARNESS_DIR: pathMod.join(repoPath, '.har'), WORK_DIR: repoPath },
    })),
  };
});

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');
const SESSION_VARS = ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CURSOR_CONVERSATION_ID'];
const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const OTHER_ATTEMPT = '22222222-2222-4222-8222-222222222222';

let home: string;
let repo: string;
const savedSessionsDir = process.env.HAR_SESSIONS_DIR;
const savedSessionVars = Object.fromEntries(SESSION_VARS.map((name) => [name, process.env[name]]));

function sh(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'har-session-seg-'));
  fs.cpSync(path.join(FIXTURE, '.har'), path.join(dir, '.har'), { recursive: true });
  for (const name of ['runs', 'slots', 'work-units', 'work-attempts', 'validation-bindings', 'session-bindings', 'artifacts']) {
    fs.rmSync(path.join(dir, '.har', name), { recursive: true, force: true });
  }
  fs.appendFileSync(path.join(dir, '.har', 'harness.env'), '\nHAR_FACTORY_PROOF=off\n');
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email har@test.local');
  sh(dir, 'git config user.name har');
  sh(dir, 'git remote add origin https://user:token@github.com/acme/widgets.git');
  fs.writeFileSync(path.join(dir, 'app.txt'), 'v1\n');
  sh(dir, 'git add -A');
  sh(dir, 'git commit -q -m init');
  return dir;
}

function slotEntry(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    agentId: 1,
    projectName: 'minimal',
    mode: 'root',
    workDir: repo,
    branch: 'main-abcd-har-agent-1-x1y2',
    createdAt: '2026-11-12T10:00:00.000Z',
    status: 'active',
    ...extra,
  };
}

function writeSlot(extra: Record<string, unknown> = {}): void {
  const file = getSlotRegistryPath(repo, 1);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(slotEntry(extra)));
}

function bindAttempt(attemptId = ATTEMPT, workUnitId = '416'): void {
  upsertWorkUnit(repo, { workUnitId, source: 'github' });
  createWorkAttempt(repo, { attemptId, workUnitId, agentId: 1, createdAt: '2026-11-12T10:00:00.000Z' });
}

function contextOf(sessionId: string, agentTool = 'claude_code'): SessionContext | undefined {
  return readSessionContextFile(sessionContextFile({ agentTool, sessionId }, home)!);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'har-home-'));
  // The run service resolves the directory itself; point it at this test's temp HOME.
  process.env.HAR_SESSIONS_DIR = path.join(home, '.har', 'sessions');
  for (const name of SESSION_VARS) delete process.env[name];
  repo = makeRepo();
});

afterEach(() => {
  process.env.HAR_SESSIONS_DIR = savedSessionsDir;
  for (const name of SESSION_VARS) {
    if (savedSessionVars[name] === undefined) delete process.env[name];
    else process.env[name] = savedSessionVars[name];
  }
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('session context files', () => {
  it('launch writes a 0600 file with telemetry-profile attributes only, never paths', () => {
    bindAttempt();
    const context = recordLaunchSegment({
      harnessRoot: repo,
      session: { agentId: 1, attemptId: ATTEMPT, workUnitId: '416', branch: 'b-1', workDir: repo },
      env: { CLAUDE_CODE_SESSION_ID: 'sess-a' },
      at: '2026-11-12T10:05:00.000Z',
      home,
    })!;
    const file = sessionContextFile({ agentTool: 'claude_code', sessionId: 'sess-a' }, home)!;
    expect(file).toBe(path.join(home, '.har', 'sessions', 'claude_code', 'sess-a.json'));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(context.segments).toEqual([
      {
        from: '2026-11-12T10:05:00.000Z',
        to: null,
        reason: 'launch',
        attributes: {
          'factory.work_unit.id': '416',
          'factory.work_unit.source': 'github',
          'factory.attempt.id': ATTEMPT,
          'factory.slot.id': '1',
          'vcs.repository.url.full': 'https://github.com/acme/widgets.git',
          'vcs.ref.head.name': 'b-1',
        },
      },
    ]);
    expect(JSON.stringify(context)).not.toContain(repo);
    expect(JSON.stringify(context)).not.toContain('token');
    // The atomic write leaves no temp file behind.
    expect(fs.readdirSync(path.dirname(file))).toEqual(['sess-a.json']);
  });

  it('omits the repository URL when the checkout has no remote', () => {
    sh(repo, 'git remote remove origin');
    const context = recordLaunchSegment({
      harnessRoot: repo,
      session: { agentId: 1, branch: 'b-1', workDir: repo },
      env: { CLAUDE_CODE_SESSION_ID: 'sess-a' },
      home,
    })!;
    expect(context.segments[0].attributes).toEqual({ 'factory.slot.id': '1', 'vcs.ref.head.name': 'b-1' });
  });

  it('no agent session (or an ambiguous one) → no file', () => {
    expect(
      recordLaunchSegment({ harnessRoot: repo, session: { agentId: 1, workDir: repo }, env: {}, home }),
    ).toBeUndefined();
    expect(
      recordLaunchSegment({
        harnessRoot: repo,
        session: { agentId: 1, workDir: repo },
        env: { CLAUDE_CODE_SESSION_ID: 'a', CODEX_THREAD_ID: 'b' },
        resolveInnermost: () => null,
        home,
      }),
    ).toBeUndefined();
    expect(fs.existsSync(path.join(home, '.har', 'sessions'))).toBe(false);
  });

  it('a relaunch from the same session closes its open segment and opens a new one', () => {
    const agent = { agentTool: 'claude_code', sessionId: 'sess-a' };
    openSessionSegment({ agent, attributes: { 'factory.slot.id': '1' }, at: '2026-11-12T10:00:00.000Z', home });
    const second = openSessionSegment({
      agent,
      attributes: { 'factory.slot.id': '2' },
      at: '2026-11-12T11:00:00.000Z',
      home,
    })!;
    expect(second.segments.map((s) => [s.from, s.to, s.attributes['factory.slot.id']])).toEqual([
      ['2026-11-12T10:00:00.000Z', '2026-11-12T11:00:00.000Z', '1'],
      ['2026-11-12T11:00:00.000Z', null, '2'],
    ]);
  });

  it('closing is keyed by the attempt: every session file, other attempts untouched', () => {
    openSessionSegment({
      agent: { agentTool: 'claude_code', sessionId: 'sess-a' },
      attributes: { 'factory.attempt.id': ATTEMPT, 'factory.slot.id': '1' },
      at: '2026-11-12T10:00:00.000Z',
      home,
    });
    openSessionSegment({
      agent: { agentTool: 'codex', sessionId: 'thread-b' },
      attributes: { 'factory.attempt.id': ATTEMPT, 'factory.slot.id': '1' },
      at: '2026-11-12T10:30:00.000Z',
      home,
    });
    openSessionSegment({
      agent: { agentTool: 'cursor', sessionId: 'conv-c' },
      attributes: { 'factory.attempt.id': OTHER_ATTEMPT, 'factory.slot.id': '2' },
      at: '2026-11-12T10:30:00.000Z',
      home,
    });
    const closed = closeSegmentsForOccupancy({
      occupancy: { attemptId: ATTEMPT, slotId: '1' },
      at: '2026-11-12T12:00:00.000Z',
      home,
    });
    expect(closed.map((c) => c.sessionId).sort()).toEqual(['sess-a', 'thread-b']);
    expect(contextOf('sess-a')!.segments[0].to).toBe('2026-11-12T12:00:00.000Z');
    expect(contextOf('thread-b', 'codex')!.segments[0].to).toBe('2026-11-12T12:00:00.000Z');
    expect(contextOf('conv-c', 'cursor')!.segments[0].to).toBeNull();
  });

  it('crash case: an open segment of an ended attempt reads as closed and is repaired on the next write', () => {
    bindAttempt();
    openSessionSegment({
      agent: { agentTool: 'claude_code', sessionId: 'sess-a' },
      attributes: { 'factory.attempt.id': ATTEMPT, 'factory.slot.id': '1' },
      at: '2026-11-12T10:00:00.000Z',
      home,
    });
    // The attempt ended but the segment was never closed (crash, older CLI).
    markWorkAttemptEnded(repo, ATTEMPT, '2026-11-12T13:00:00.000Z');
    const stale = contextOf('sess-a')!;
    expect(stale.segments[0].to).toBeNull();
    const ended = (id: string) => findWorkAttempt(repo, id)?.endedAt !== undefined;
    expect(segmentInForce(stale, '2026-11-12T14:00:00.000Z', { isAttemptEnded: ended })).toBeUndefined();
    expect(
      computeSessionRefs({
        occupancy: { attemptId: ATTEMPT, slotId: '1' },
        windowEnd: '2026-11-12T15:00:00.000Z',
        attemptEndedAt: (id) => findWorkAttempt(repo, id)?.endedAt,
        home,
      })[0].to,
    ).toBe('2026-11-12T13:00:00.000Z');

    // Any later write of a session file (here: another session's launch) repairs it.
    recordLaunchSegment({
      harnessRoot: repo,
      session: { agentId: 2, workDir: repo, branch: 'other' },
      env: { CODEX_THREAD_ID: 'thread-z' },
      at: '2026-11-12T15:00:00.000Z',
      home,
    });
    expect(contextOf('sess-a')!.segments[0].to).toBe('2026-11-12T13:00:00.000Z');
  });

  it('skips unreadable files', () => {
    const bad = path.join(home, '.har', 'sessions', 'claude_code', 'broken.json');
    fs.mkdirSync(path.dirname(bad), { recursive: true });
    fs.writeFileSync(bad, '{not json');
    writeSessionContextFile(path.join(home, '.har', 'sessions', 'claude_code', 'ok.json'), {
      version: 1,
      agentTool: 'claude_code',
      sessionId: 'ok',
      segments: [],
    });
    expect(listSessionContexts(home).map((entry) => entry.context.sessionId)).toEqual(['ok']);
  });
});

describe('session refs', () => {
  function seed() {
    openSessionSegment({
      agent: { agentTool: 'claude_code', sessionId: 'early' },
      attributes: { 'factory.attempt.id': ATTEMPT, 'factory.slot.id': '1' },
      at: '2026-11-12T10:00:00.000Z',
      home,
    });
    closeSegmentsForOccupancy({ occupancy: { attemptId: ATTEMPT, slotId: '1' }, at: '2026-11-12T10:30:00.000Z', home });
    openSessionSegment({
      agent: { agentTool: 'codex', sessionId: 'late' },
      attributes: { 'factory.attempt.id': ATTEMPT, 'factory.slot.id': '1' },
      at: '2026-11-12T11:00:00.000Z',
      home,
    });
    openSessionSegment({
      agent: { agentTool: 'cursor', sessionId: 'elsewhere' },
      attributes: { 'factory.attempt.id': OTHER_ATTEMPT, 'factory.slot.id': '2' },
      at: '2026-11-12T10:00:00.000Z',
      home,
    });
  }

  it('lists the attempt sessions overlapping [attempt start, run finish], flags the verifying one', () => {
    seed();
    const refs = computeSessionRefs({
      occupancy: { attemptId: ATTEMPT, slotId: '1' },
      windowStart: '2026-11-12T09:00:00.000Z',
      windowEnd: '2026-11-12T12:00:00.000Z',
      ranVerify: { agentTool: 'codex', sessionId: 'late' },
      home,
    });
    expect(refs).toEqual([
      { agentTool: 'claude_code', sessionId: 'early', from: '2026-11-12T10:00:00.000Z', to: '2026-11-12T10:30:00.000Z', ranVerify: false },
      { agentTool: 'codex', sessionId: 'late', from: '2026-11-12T11:00:00.000Z', to: null, ranVerify: true },
    ]);
  });

  it('excludes segments that start after the run finished', () => {
    seed();
    const refs = computeSessionRefs({
      occupancy: { attemptId: ATTEMPT, slotId: '1' },
      windowEnd: '2026-11-12T10:45:00.000Z',
      home,
    });
    expect(refs.map((ref) => ref.sessionId)).toEqual(['early']);
  });

  it('merges a re-verify of the same tree instead of replacing', () => {
    const first = [
      { agentTool: 'claude_code', sessionId: 'a', from: '2026-11-12T10:00:00.000Z', to: null, ranVerify: true },
      { agentTool: 'codex', sessionId: 'gone', from: '2026-11-12T09:00:00.000Z', to: '2026-11-12T09:30:00.000Z', ranVerify: false },
    ];
    const second = [
      { agentTool: 'claude_code', sessionId: 'a', from: '2026-11-12T10:00:00.000Z', to: '2026-11-12T12:00:00.000Z', ranVerify: false },
      { agentTool: 'cursor', sessionId: 'new', from: '2026-11-12T11:00:00.000Z', to: null, ranVerify: true },
    ];
    expect(mergeSessionRefs(first, second)).toEqual([
      { agentTool: 'codex', sessionId: 'gone', from: '2026-11-12T09:00:00.000Z', to: '2026-11-12T09:30:00.000Z', ranVerify: false },
      { agentTool: 'claude_code', sessionId: 'a', from: '2026-11-12T10:00:00.000Z', to: '2026-11-12T12:00:00.000Z', ranVerify: true },
      { agentTool: 'cursor', sessionId: 'new', from: '2026-11-12T11:00:00.000Z', to: null, ranVerify: true },
    ]);
  });
});

describe('run service: launch, teardown, complete, verify', () => {
  it('launch opens a segment; a terminal teardown (no agent session) closes it, then ends the attempt', async () => {
    mockSlotEntry.current = slotEntry();
    process.env.CLAUDE_CODE_SESSION_ID = 'agent-session';
    const launch = await launchEnvironment({ repoPath: repo, agentId: 1, capture: true, workUnitId: '416' });
    expect(launch.code).toBe(0);
    const attemptId = launch.attemptId!;
    const opened = contextOf('agent-session')!;
    expect(opened.segments).toHaveLength(1);
    expect(opened.segments[0]).toMatchObject({
      to: null,
      reason: 'launch',
      attributes: { 'factory.attempt.id': attemptId, 'factory.work_unit.id': '416', 'factory.slot.id': '1' },
    });

    delete process.env.CLAUDE_CODE_SESSION_ID;
    const teardown = await teardownEnvironment({ repoPath: repo, agentId: 1, capture: true });
    expect(teardown.code).toBe(0);
    const closed = contextOf('agent-session')!.segments.at(-1)!;
    expect(closed.to).not.toBeNull();
    const attempt = findWorkAttempt(repo, attemptId)!;
    expect(attempt.endedAt).toBeDefined();
    // Segments are closed first, each at its own write decision; the attempt ends after them.
    expect(Date.parse(attempt.endedAt!)).toBeGreaterThanOrEqual(Date.parse(closed.to!));
    expect(Date.parse(attempt.endedAt!) - Date.parse(closed.to!)).toBeLessThan(5_000);
  });

  it('complete closes the attempt segments of every session', async () => {
    bindAttempt();
    writeSlot({ workUnitId: '416', attemptId: ATTEMPT });
    openSessionSegment({
      agent: { agentTool: 'claude_code', sessionId: 'worker' },
      attributes: { 'factory.attempt.id': ATTEMPT, 'factory.slot.id': '1' },
      home,
    });
    const verify = await runVerification({ repoPath: repo, agentId: 1, full: true, capture: true });
    expect(verify.verification?.status).toBe('pass');
    const result = await completeEnvironment({ repoPath: repo, agentId: 1, capture: true });
    expect(result.code).toBe(0);
    expect(contextOf('worker')!.segments[0].to).not.toBeNull();
    expect(findWorkAttempt(repo, ATTEMPT)!.endedAt).toBeDefined();
  });

  it('verify stores session refs, stage results and evidence digests on the factory run', async () => {
    bindAttempt();
    writeSlot({ workUnitId: '416', attemptId: ATTEMPT });
    const registry = JSON.parse(fs.readFileSync(path.join(repo, '.har', 'stages.json'), 'utf8'));
    registry.verificationStages = ['smoke', 'shots'];
    registry.stages = [
      ...registry.stages.filter((stage: { id: string }) => stage.id !== 'smoke'),
      { id: 'smoke', kind: 'test', tier: 'quick', command: 'echo smoke-out; sleep 0.1; echo smoke-err >&2' },
      {
        id: 'shots',
        kind: 'test',
        tier: 'full',
        command: 'mkdir -p .har/artifacts/shots && printf png > .har/artifacts/shots/home.png',
      },
    ];
    fs.writeFileSync(path.join(repo, '.har', 'stages.json'), JSON.stringify(registry, null, 2));
    sh(repo, 'git add -A && git commit -q -m stages');
    openSessionSegment({
      agent: { agentTool: 'claude_code', sessionId: 'worker' },
      attributes: { 'factory.attempt.id': ATTEMPT, 'factory.slot.id': '1' },
      at: '2026-11-12T10:01:00.000Z',
      home,
    });
    process.env.CODEX_THREAD_ID = 'verifier';

    const first = await runVerification({ repoPath: repo, agentId: 1, full: true, capture: true });
    expect(first.verification?.status).toBe('pass');
    const validation = first.validation!;
    const runDir = path.join(repo, '.har', 'artifacts', validation.validationId);
    expect(fs.readFileSync(path.join(runDir, 'smoke.log'), 'utf8')).toBe('smoke-out\nsmoke-err\n');
    expect(fs.readdirSync(runDir).sort()).toEqual(['shots.log', 'smoke.log']);
    expect(fs.existsSync(path.join(repo, '.har', 'artifacts', '.staging'))).toBe(false);

    const stored = findValidation(repo, validation.treeHash)!;
    expect(stored.factoryLine).toBeNull();
    expect(stored.station).toBeNull();
    expect(stored.finishedAt).toBeDefined();
    const shots = stored.stageResults!.find((stage) => stage.stageId === 'shots')!;
    expect(shots).toMatchObject({ status: 'passed', addedBy: 'policy', kind: 'test' });
    expect(shots.artifacts.map((file) => [file.name, file.mediaType, file.size])).toEqual([
      [`${validation.validationId}/shots.log`, 'text/plain; charset=utf-8', 0],
      ['shots/home.png', 'image/png', 3],
    ]);
    expect(shots.logDigest).toBe(shots.artifacts[0].sha256);
    expect(shots.artifacts[1].sha256).toBe(crypto.createHash('sha256').update('png').digest('hex'));
    expect(stored.sessions).toEqual([
      expect.objectContaining({ agentTool: 'claude_code', sessionId: 'worker', to: null, ranVerify: false }),
      expect.objectContaining({ agentTool: 'codex', sessionId: 'verifier', ranVerify: true }),
    ]);
    // Logs and artifacts live in ignored paths: the verified tree is unchanged by them.
    expect(computeWorktreeSnapshot(repo).treeHash).toBe(validation.treeHash);

    // Re-verify the same tree from another session: same factory run, refs merged.
    delete process.env.CODEX_THREAD_ID;
    process.env.CURSOR_CONVERSATION_ID = 'second-verifier';
    const second = await runVerification({ repoPath: repo, agentId: 1, full: true, capture: true });
    expect(second.validation!.validationId).toBe(validation.validationId);
    const merged = findValidation(repo, validation.treeHash)!;
    expect(merged.sessions!.map((ref) => [ref.sessionId, ref.ranVerify])).toEqual([
      ['worker', false],
      ['verifier', true],
      ['second-verifier', true],
    ]);
    expect(fs.readdirSync(runDir).sort()).toEqual(['shots.log', 'smoke.log']);
  });

  it('rejects a station when no line is installed, before running anything', async () => {
    writeSlot();
    await expect(
      runVerification({ repoPath: repo, agentId: 1, full: true, capture: true, station: 'nope' }),
    ).rejects.toThrow(/No factory line installed/);
  });
});

describe('work-bind moves sessions to the new attempt', () => {
  it('closes the old segments, opens new ones for those sessions and the caller, ends the old attempt', () => {
    bindAttempt();
    openSessionSegment({
      agent: { agentTool: 'claude_code', sessionId: 'worker' },
      attributes: { 'factory.attempt.id': ATTEMPT, 'factory.slot.id': '1' },
      at: '2026-11-12T10:00:00.000Z',
      home,
    });
    bindAttempt(OTHER_ATTEMPT, '417');
    const opened = rebindSlotSegments({
      harnessRoot: repo,
      before: { agentId: 1, attemptId: ATTEMPT, workUnitId: '416', workDir: repo },
      after: { agentId: 1, attemptId: OTHER_ATTEMPT, workUnitId: '417', workDir: repo },
      env: { CODEX_THREAD_ID: 'binder' },
      at: '2026-11-12T11:00:00.000Z',
      home,
    });
    expect(opened.map((agent) => agent.sessionId).sort()).toEqual(['binder', 'worker']);
    expect(contextOf('worker')!.segments.map((s) => [s.to, s.attributes['factory.attempt.id']])).toEqual([
      ['2026-11-12T11:00:00.000Z', ATTEMPT],
      [null, OTHER_ATTEMPT],
    ]);
    expect(findWorkAttempt(repo, ATTEMPT)!.endedAt).toBe('2026-11-12T11:00:00.000Z');
    expect(findWorkAttempt(repo, OTHER_ATTEMPT)!.endedAt).toBeUndefined();
  });
});

describe('boundaries at the write decision, and locked files', () => {
  afterEach(() => setSessionContextLockOptions({}));

  it('without a pinned instant, a rebind closes and opens at one instant and ends the old attempt after it', () => {
    bindAttempt();
    openSessionSegment({
      agent: { agentTool: 'claude_code', sessionId: 'worker' },
      attributes: { 'factory.attempt.id': ATTEMPT, 'factory.slot.id': '1' },
      at: '2026-11-12T10:00:00.000Z',
      home,
    });
    bindAttempt(OTHER_ATTEMPT, '417');
    const before = Date.now();
    rebindSlotSegments({
      harnessRoot: repo,
      before: { agentId: 1, attemptId: ATTEMPT, workUnitId: '416', workDir: repo },
      after: { agentId: 1, attemptId: OTHER_ATTEMPT, workUnitId: '417', workDir: repo },
      env: {},
      home,
    });
    const after = Date.now();
    const [old, fresh] = contextOf('worker')!.segments;
    expect(old.to).toBe(fresh.from);
    expect(Date.parse(old.to!)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(old.to!)).toBeLessThanOrEqual(after);
    expect(Date.parse(findWorkAttempt(repo, ATTEMPT)!.endedAt!)).toBeGreaterThanOrEqual(Date.parse(old.to!));
  });

  it('teardown with a session file locked by a live process: other files closed, attempt ended, error reported', () => {
    bindAttempt();
    for (const sessionId of ['free', 'busy']) {
      openSessionSegment({
        agent: { agentTool: 'claude_code', sessionId },
        attributes: { 'factory.attempt.id': ATTEMPT, 'factory.slot.id': '1' },
        at: '2026-11-12T10:00:00.000Z',
        home,
      });
    }
    const busy = sessionContextFile({ agentTool: 'claude_code', sessionId: 'busy' }, home)!;
    fs.writeFileSync(`${busy}.lock`, JSON.stringify({ pid: process.pid, token: 'other' }));
    setSessionContextLockOptions({ timeoutMs: 100 });
    expect(() =>
      endSlotOccupancySegments({ harnessRoot: repo, session: { agentId: 1, attemptId: ATTEMPT, workDir: repo }, home }),
    ).toThrow(SessionContextLockError);
    expect(contextOf('free')!.segments[0].to).not.toBeNull();
    expect(contextOf('busy')!.segments[0].to).toBeNull();
    const endedAt = findWorkAttempt(repo, ATTEMPT)!.endedAt!;
    expect(endedAt).toBeDefined();
    // Readers treat the busy session's open segment as closed: its attempt ended.
    expect(segmentInForce(contextOf('busy')!, Date.now(), { isAttemptEnded: (id) => id === ATTEMPT })).toBeUndefined();
    // Once the lock is gone, the next write repairs it to the attempt's end.
    fs.rmSync(`${busy}.lock`);
    openSessionSegment({ agent: { agentTool: 'codex', sessionId: 'later' }, attributes: { 'factory.slot.id': '2' }, attemptEndedAt: (id) => (id === ATTEMPT ? endedAt : undefined), home });
    expect(contextOf('busy')!.segments[0].to).toBe(endedAt);
  });
});

describe('factory line and station on the factory run', () => {
  it('records the station a verify ran at', async () => {
    applyLine(repo, 'example-line');
    sh(repo, 'git add -A && git commit -q -m line');
    writeSlot();
    const verify = await runVerification({ repoPath: repo, agentId: 1, capture: true, station: 'S2' });
    const stored = findValidation(repo, verify.validation!.treeHash)!;
    expect([stored.factoryLine, stored.station]).toEqual(['example-line', 'S2']);
    await expect(
      runVerification({ repoPath: repo, agentId: 1, capture: true, line: 'example-line', station: 'S9' }),
    ).rejects.toThrow(/Unknown station "S9"/);
    await expect(runVerification({ repoPath: repo, agentId: 1, capture: true, line: 'example-line' })).rejects.toThrow(
      /--station/,
    );
  });
});

describe('stage evidence in the proof', () => {
  it('lists each stage log and artifact by sha256 in stages[].artifacts[]', () => {
    const registry = HarnessStageRegistrySchema.parse({
      version: '1',
      agentSlots: { min: 1, max: 3 },
      verificationStages: ['unit', 'e2e'],
      stages: [
        { id: 'unit', kind: 'test', command: 'true' },
        { id: 'e2e', kind: 'test', command: 'true' },
      ],
    });
    const digest = 'a'.repeat(64);
    const predicate = buildFactoryRunPredicate({
      validation: { validationId: 'run-1' },
      verification: {
        status: 'pass',
        agent_id: 1,
        stages: [
          { name: 'unit', pass: true, ms: 5 },
          { name: 'e2e', pass: true, ms: 9 },
        ],
      },
      registry,
      producerVersion: '2.0.0',
      stageArtifacts: new Map([
        [
          'e2e',
          [
            { name: 'run-1/e2e.log', sha256: digest },
            { name: 'e2e/home.png', sha256: 'b'.repeat(64) },
          ],
        ],
      ]),
      env: {},
    });
    expect(predicate.stages.find((stage) => stage.id === 'unit')!.artifacts).toBeUndefined();
    expect(predicate.stages.find((stage) => stage.id === 'e2e')!.artifacts).toEqual([
      { name: 'run-1/e2e.log', digest: { sha256: digest } },
      { name: 'e2e/home.png', digest: { sha256: 'b'.repeat(64) } },
    ]);
  });

  it('keeps no evidence when the runner wrote no index (older runner, custom verify)', () => {
    const artifactsRoot = path.join(repo, '.har', 'artifacts');
    const stagingDir = path.join(artifactsRoot, '.staging', 'x');
    fs.mkdirSync(stagingDir, { recursive: true });
    expect(finalizeStageEvidence({ stagingDir, artifactsRoot, factoryRunId: ATTEMPT })).toBeUndefined();
    expect(fs.existsSync(path.join(artifactsRoot, '.staging'))).toBe(false);
  });
});

describe('slot repository URL', () => {
  it("falls back to the main checkout's remote once the slot worktree is removed", () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-slot-url-'));
    try {
      execSync('git init -q && git remote add origin https://github.com/acme/app.git', { cwd: repo });
      const removed = path.join(repo, 'worktrees', 'gone');
      expect(slotRepositoryUrl(removed, repo)).toBe('https://github.com/acme/app.git');
      expect(slotRepositoryUrl(undefined, repo)).toBe('https://github.com/acme/app.git');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
