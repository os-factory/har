import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchEnvironment, teardownEnvironment } from '../src/core/run-service';
import { getSlotRegistryPath } from '../src/core/slot-registry';
import {
  listSessionBindings,
  recordLaunchBinding,
  recordReleaseBindings,
  slotOccupancyKey,
} from '../src/core/session-bindings';
import type { SlotRegistryEntry } from '../src/harness/schema';

const mockSlotEntry: { current: Record<string, unknown> | null } = { current: null };

// The run service is the one core behind CLI and MCP; stub only the runtime
// pipelines and let launch "write" the slot record a real launch would.
jest.mock('../src/runtime', () => {
  const actual = jest.requireActual('../src/runtime');
  const fsMod = jest.requireActual('fs');
  const pathMod = jest.requireActual('path');
  return {
    ...actual,
    launchSession: jest.fn(async (options: { repoPath: string; agentId: number }) => {
      const file = pathMod.join(options.repoPath, '.har', 'slots', `agent-${options.agentId}.json`);
      fsMod.mkdirSync(pathMod.dirname(file), { recursive: true });
      fsMod.writeFileSync(file, JSON.stringify(mockSlotEntry.current));
      return { code: 0 };
    }),
    teardownSession: jest.fn(async (options: { repoPath: string; agentId: number }) => {
      fsMod.rmSync(
        pathMod.join(options.repoPath, '.har', 'slots', `agent-${options.agentId}.json`),
        { force: true },
      );
      return { code: 0 };
    }),
  };
});

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');
let repo: string;

function makeTempRepo(): string {
  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-session-bindings-'));
  fs.cpSync(path.join(FIXTURE, '.har'), path.join(tempRepo, '.har'), { recursive: true });
  for (const dir of ['runs', 'slots', 'work-units', 'work-attempts', 'session-bindings']) {
    fs.rmSync(path.join(tempRepo, '.har', dir), { recursive: true, force: true });
  }
  return tempRepo;
}

function slotEntry(extra: Partial<SlotRegistryEntry> = {}): SlotRegistryEntry {
  return {
    version: 1,
    agentId: 2,
    projectName: 'minimal',
    mode: 'worktree',
    workDir: '/tmp/wt-2',
    worktreePath: '/tmp/wt-2',
    branch: 'main-abcd-har-agent-2-x1y2',
    createdAt: '2026-11-12T10:00:00.000Z',
    status: 'active',
    ...extra,
  };
}

beforeEach(() => {
  repo = makeTempRepo();
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  for (const name of ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CURSOR_CONVERSATION_ID']) {
    delete process.env[name];
  }
});

describe('slotOccupancyKey', () => {
  it('derives the same occupancy key as Mission Control (#316)', () => {
    expect(slotOccupancyKey(slotEntry({ attemptId: 'a-1' }))).toBe('attempt::a-1');
    expect(slotOccupancyKey(slotEntry())).toBe(
      'branch::main-abcd-har-agent-2-x1y2::2026-11-12T10:00:00.000Z',
    );
    expect(slotOccupancyKey(slotEntry({ branch: undefined }))).toBe(
      'path::/tmp/wt-2::2026-11-12T10:00:00.000Z',
    );
    // Normalized to ISO like Mission Control's `new Date(...).toISOString()`.
    expect(slotOccupancyKey(slotEntry({ createdAt: '2026-11-12T11:00:00+01:00' }))).toBe(
      'branch::main-abcd-har-agent-2-x1y2::2026-11-12T10:00:00.000Z',
    );
  });
});

describe('launch / release bindings', () => {
  it('records nothing outside an agent', () => {
    expect(recordLaunchBinding({ harnessRoot: repo, session: slotEntry(), env: {} })).toBeNull();
    expect(recordReleaseBindings({ harnessRoot: repo, session: slotEntry(), env: {} })).toEqual([]);
    expect(listSessionBindings(repo)).toEqual([]);
  });

  it('records a launch binding for the agent session that ran the launch', () => {
    const binding = recordLaunchBinding({
      harnessRoot: repo,
      session: slotEntry({ attemptId: 'a-1' }),
      env: { CLAUDE_CODE_SESSION_ID: 'sess-1' },
      at: '2026-11-12T10:00:05.000Z',
    });

    expect(binding).toEqual({
      agentTool: 'claude_code',
      sessionId: 'sess-1',
      kind: 'launch',
      slotId: 2,
      occupancyKey: 'attempt::a-1',
      branch: 'main-abcd-har-agent-2-x1y2',
      at: '2026-11-12T10:00:05.000Z',
    });
    expect(listSessionBindings(repo)).toEqual([binding]);
    expect(fs.readFileSync(path.join(repo, '.har', '.gitignore'), 'utf8')).toContain(
      'session-bindings/',
    );
  });

  it('is idempotent: recording the same binding twice keeps one', () => {
    const input = {
      harnessRoot: repo,
      session: slotEntry(),
      env: { CODEX_THREAD_ID: 'thread-1' },
      at: '2026-11-12T10:00:05.000Z',
    };
    recordLaunchBinding(input);
    recordLaunchBinding(input);
    expect(listSessionBindings(repo)).toHaveLength(1);
  });

  it('releases the running session and every session that launched this occupancy', () => {
    const session = slotEntry({ attemptId: 'a-1' });
    recordLaunchBinding({
      harnessRoot: repo,
      session,
      env: { CLAUDE_CODE_SESSION_ID: 'launcher' },
      at: '2026-11-12T10:00:05.000Z',
    });
    // A launch of an earlier occupancy of the same slot is not released again.
    recordLaunchBinding({
      harnessRoot: repo,
      session: slotEntry({ attemptId: 'a-0' }),
      env: { CLAUDE_CODE_SESSION_ID: 'old' },
      at: '2026-11-11T10:00:05.000Z',
    });

    const released = recordReleaseBindings({
      harnessRoot: repo,
      session,
      env: { CURSOR_CONVERSATION_ID: "'conv-9'" },
      at: '2026-11-12T12:00:00.000Z',
    });

    expect(released.map((b) => [b.agentTool, b.sessionId, b.kind]).sort()).toEqual([
      ['claude_code', 'launcher', 'release'],
      ['cursor', 'conv-9', 'release'],
    ]);
    expect(released.every((b) => b.occupancyKey === 'attempt::a-1')).toBe(true);
  });

  it('a human teardown (no agent env) still releases the launching session', () => {
    const session = slotEntry();
    recordLaunchBinding({ harnessRoot: repo, session, env: { CLAUDE_CODE_SESSION_ID: 's' } });
    const released = recordReleaseBindings({ harnessRoot: repo, session, env: {} });
    expect(released).toHaveLength(1);
    expect(released[0]).toMatchObject({ sessionId: 's', kind: 'release', slotId: 2 });
  });
});

describe('run service (CLI and MCP) records bindings', () => {
  it('launch binds the launching agent session; teardown releases it', async () => {
    mockSlotEntry.current = {
      ...slotEntry({ workDir: repo, worktreePath: undefined, mode: 'root', agentId: 1 }),
    };
    process.env.CLAUDE_CODE_SESSION_ID = 'agent-session';

    const launch = await launchEnvironment({ repoPath: repo, agentId: 1, capture: true });
    expect(launch.code).toBe(0);
    expect(listSessionBindings(repo)).toEqual([
      expect.objectContaining({
        agentTool: 'claude_code',
        sessionId: 'agent-session',
        kind: 'launch',
        slotId: 1,
        branch: 'main-abcd-har-agent-2-x1y2',
      }),
    ]);

    delete process.env.CLAUDE_CODE_SESSION_ID;
    const teardown = await teardownEnvironment({ repoPath: repo, agentId: 1, capture: true });
    expect(teardown.code).toBe(0);
    expect(fs.existsSync(getSlotRegistryPath(repo, 1))).toBe(false);
    expect(listSessionBindings(repo).map((b) => [b.kind, b.sessionId])).toEqual([
      ['launch', 'agent-session'],
      ['release', 'agent-session'],
    ]);
  });

  it('a launch outside any agent records no binding', async () => {
    mockSlotEntry.current = {
      ...slotEntry({ workDir: repo, worktreePath: undefined, mode: 'root', agentId: 1 }),
    };
    const launch = await launchEnvironment({ repoPath: repo, agentId: 1, capture: true });
    expect(launch.code).toBe(0);
    expect(listSessionBindings(repo)).toEqual([]);
  });
});
