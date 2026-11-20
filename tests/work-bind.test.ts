import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../src/core/control-notify', () => ({
  notifyControlSync: jest.fn(),
}));

import { bindWorkUnit, findSlotForPath, WorkBindError } from '../src/core/work-bind';
import { readSlotRegistry, writeSlotRegistry } from '../src/core/slot-registry';
import {
  listSessionBindings,
  recordLaunchBinding,
  slotOccupancyKey,
} from '../src/core/session-bindings';
import { findWorkUnit, listWorkAttempts, upsertWorkUnit } from '../src/core/work-units';
import { handleMcpToolCall } from '../src/mcp/server';
import { handleWorkBind } from '../src/cli/commands/env';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');
const LAUNCHED_AT = '2026-11-17T10:00:00.000Z';
const CLAUDE_ENV = { CLAUDE_CODE_SESSION_ID: 'sess-claude-1' };

function makeRepo(): { repo: string; workDir: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-work-bind-'));
  fs.cpSync(path.join(FIXTURE, '.har'), path.join(repo, '.har'), { recursive: true });
  for (const dir of ['runs', 'slots', 'work-units', 'work-attempts', 'session-bindings']) {
    fs.rmSync(path.join(repo, '.har', dir), { recursive: true, force: true });
  }
  const workDir = path.join(repo, 'worktrees', 'main-abcd-har-agent-2-wxyz');
  fs.mkdirSync(path.join(workDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(workDir, '.env.agent.2'), 'PORT=3020\n');
  writeSlotRegistry(repo, {
    agentId: 2,
    projectName: 'fixture',
    mode: 'worktree',
    workDir,
    worktreePath: workDir,
    branch: 'main-abcd-har-agent-2-wxyz',
    baseBranch: 'main',
    baseCommit: 'a'.repeat(40),
    suffix: 'wxyz',
    ports: { frontend: 3020 },
    createdAt: LAUNCHED_AT,
    notifyControl: false,
  });
  return { repo, workDir };
}

describe('bindWorkUnit', () => {
  let repo: string;
  let workDir: string;

  beforeEach(() => {
    ({ repo, workDir } = makeRepo());
  });
  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('finds the slot whose work dir contains the cwd', () => {
    expect(findSlotForPath(repo, path.join(workDir, 'src'))?.session.agentId).toBe(2);
    expect(findSlotForPath(repo, repo)).toBeUndefined();
  });

  it('[VER-8] binds an unbound slot: new attempt owning the occupancy since launch', () => {
    const before = readSlotRegistry(repo, 2)!;
    const result = bindWorkUnit({
      repoPath: repo,
      cwd: path.join(workDir, 'src'),
      workUnitId: 'FE-2071',
      title: 'Bind work after launch',
      sourceUrl: 'https://linear.app/acme/issue/FE-2071',
      env: {},
      now: '2026-11-17T11:00:00.000Z',
    });

    expect(result).toMatchObject({ ok: true, agentId: 2, workUnitId: 'FE-2071', changed: true });
    expect(result.previousWorkUnitId).toBeUndefined();

    const slot = readSlotRegistry(repo, 2)!;
    expect(slot).toMatchObject({
      workUnitId: 'FE-2071',
      attemptId: result.attemptId,
      ports: { frontend: 3020 },
      branch: before.branch,
      createdAt: LAUNCHED_AT,
    });

    const [attempt] = listWorkAttempts(repo);
    expect(attempt).toMatchObject({
      attemptId: result.attemptId,
      workUnitId: 'FE-2071',
      agentId: 2,
      workDir,
      branch: before.branch,
      createdAt: LAUNCHED_AT,
      boundAt: '2026-11-17T11:00:00.000Z',
      previousOccupancyKey: slotOccupancyKey(before),
    });
    expect(attempt.previousAttemptId).toBeUndefined();
    expect(findWorkUnit(repo, 'FE-2071')).toMatchObject({ title: 'Bind work after launch' });

    const env = fs.readFileSync(path.join(workDir, '.env.agent.2'), 'utf8');
    expect(env).toContain('PORT=3020');
    expect(env).toContain('HAR_WORK_UNIT_ID=FE-2071');
    expect(env).toContain(`HAR_ATTEMPT_ID=${result.attemptId}`);
  });

  it('rebinds to another unit: new attempt, old unit closed but keeps its attempt', () => {
    const first = bindWorkUnit({ repoPath: repo, agentId: 2, workUnitId: 'FE-1', env: {} });
    const second = bindWorkUnit({
      repoPath: repo,
      agentId: 2,
      workUnitId: 'FE-2',
      env: {},
      now: '2026-11-17T12:00:00.000Z',
    });

    expect(second).toMatchObject({
      changed: true,
      previousWorkUnitId: 'FE-1',
      previousAttemptId: first.attemptId,
    });
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(findWorkUnit(repo, 'FE-1')?.outcome).toMatchObject({
      decision: 'abandoned',
      attemptId: first.attemptId,
    });
    const attempts = listWorkAttempts(repo);
    expect(attempts.find((a) => a.attemptId === first.attemptId)?.workUnitId).toBe('FE-1');
    expect(attempts.find((a) => a.attemptId === second.attemptId)).toMatchObject({
      workUnitId: 'FE-2',
      createdAt: '2026-11-17T12:00:00.000Z',
      previousAttemptId: first.attemptId,
    });
    expect(readSlotRegistry(repo, 2)?.workUnitId).toBe('FE-2');
  });

  it('is idempotent for the unit the slot already carries', () => {
    const first = bindWorkUnit({ repoPath: repo, agentId: 2, workUnitId: 'FE-1', env: {} });
    const again = bindWorkUnit({
      repoPath: repo,
      agentId: 2,
      workUnitId: 'FE-1',
      title: 'Now with a title',
      env: {},
    });
    expect(again).toMatchObject({ changed: false, attemptId: first.attemptId });
    expect(listWorkAttempts(repo)).toHaveLength(1);
    expect(findWorkUnit(repo, 'FE-1')?.title).toBe('Now with a title');
  });

  it('[VER-7] refuses a unit bound to another slot, and leaves the slot untouched', () => {
    writeSlotRegistry(repo, {
      agentId: 3,
      projectName: 'fixture',
      mode: 'worktree',
      workDir: path.join(repo, 'other'),
      workUnitId: 'FE-9',
      attemptId: '99999999-9999-4999-8999-999999999999',
      notifyControl: false,
    });
    expect(() => bindWorkUnit({ repoPath: repo, agentId: 2, workUnitId: 'FE-9', env: {} })).toThrow(
      /already bound to slot 3/,
    );
    expect(readSlotRegistry(repo, 2)?.workUnitId).toBeUndefined();
  });

  it('refuses an immutable metadata clash before touching the slot', () => {
    upsertWorkUnit(repo, { workUnitId: 'FE-5', title: 'Original' });
    expect(() =>
      bindWorkUnit({ repoPath: repo, agentId: 2, workUnitId: 'FE-5', title: 'Other', env: {} }),
    ).toThrow(WorkBindError);
    expect(readSlotRegistry(repo, 2)?.workUnitId).toBeUndefined();
    expect(listWorkAttempts(repo)).toHaveLength(0);
  });

  it('refuses a slot that is not active and a cwd outside any slot', () => {
    const slot = readSlotRegistry(repo, 2)!;
    writeSlotRegistry(repo, { ...slot, status: 'failed', notifyControl: false });
    expect(() => bindWorkUnit({ repoPath: repo, agentId: 2, workUnitId: 'FE-1', env: {} })).toThrow(
      /failed, not active/,
    );
    expect(() => bindWorkUnit({ repoPath: repo, cwd: os.tmpdir(), workUnitId: 'FE-1', env: {} })).toThrow(
      /not inside a slot work dir/,
    );
  });

  it('moves session bindings from the old occupancy key to the new attempt', () => {
    const before = readSlotRegistry(repo, 2)!;
    recordLaunchBinding({
      harnessRoot: repo,
      session: before,
      env: CLAUDE_ENV,
      at: '2026-11-17T10:00:01.000Z',
    });
    const result = bindWorkUnit({
      repoPath: repo,
      agentId: 2,
      workUnitId: 'FE-1',
      env: CLAUDE_ENV,
      now: '2026-11-17T11:00:00.000Z',
    });
    const oldKey = slotOccupancyKey(before);
    const newKey = slotOccupancyKey(readSlotRegistry(repo, 2)!);
    expect(newKey).toContain(result.attemptId);
    const bindings = listSessionBindings(repo).map((b) => [b.kind, b.occupancyKey, b.sessionId]);
    expect(bindings).toEqual(
      expect.arrayContaining([
        ['launch', oldKey, 'sess-claude-1'],
        ['release', oldKey, 'sess-claude-1'],
        ['launch', newKey, 'sess-claude-1'],
      ]),
    );
    expect(bindings).toHaveLength(3);
  });
});

describe('work-bind CLI ↔ MCP parity', () => {
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    process.exitCode = undefined;
  });
  afterEach(() => {
    exitSpy.mockRestore();
    logSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('[SRF-2] writes the same slot, unit and attempt records from both surfaces', async () => {
    const cli = makeRepo();
    const mcp = makeRepo();
    try {
      await handleWorkBind({
        id: 2,
        repo: cli.repo,
        workId: 'FE-2071',
        workTitle: 'Parity',
        workUrl: 'https://linear.app/acme/issue/FE-2071',
        json: true,
      });
      const cliOut = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));

      const response = await handleMcpToolCall('har_bind_work_unit', {
        repo: mcp.repo,
        cwd: path.join(mcp.workDir, 'src'),
        workUnitId: 'FE-2071',
        title: 'Parity',
        sourceUrl: 'https://linear.app/acme/issue/FE-2071',
      });
      expect(response.isError).toBeUndefined();
      const mcpOut = JSON.parse(response.content[0].text);

      const shape = (out: Record<string, unknown>) => ({
        ok: out.ok,
        agentId: out.agentId,
        workUnitId: out.workUnitId,
        changed: out.changed,
      });
      expect(shape(cliOut)).toEqual(shape(mcpOut));
      for (const { repo } of [cli, mcp]) {
        expect(readSlotRegistry(repo, 2)?.workUnitId).toBe('FE-2071');
        expect(listWorkAttempts(repo)).toHaveLength(1);
        expect(findWorkUnit(repo, 'FE-2071')).toMatchObject({
          title: 'Parity',
          sourceUrl: 'https://linear.app/acme/issue/FE-2071',
        });
      }
    } finally {
      fs.rmSync(cli.repo, { recursive: true, force: true });
      fs.rmSync(mcp.repo, { recursive: true, force: true });
    }
  });

  it('reports the same refusal on both surfaces', async () => {
    const { repo } = makeRepo();
    try {
      await handleWorkBind({ repo, workId: 'FE-1', json: true });
      const cliOut = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
      const response = await handleMcpToolCall('har_bind_work_unit', {
        repo,
        cwd: repo,
        workUnitId: 'FE-1',
      });
      expect(response.isError).toBe(true);
      const mcpOut = JSON.parse(response.content[0].text);
      expect(cliOut.ok).toBe(false);
      expect(mcpOut.ok).toBe(false);
      expect(cliOut.error).toMatch(/not inside a slot work dir/);
      expect(mcpOut.error).toMatch(/not inside a slot work dir/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
