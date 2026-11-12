import { beforeEach, describe, expect, it, vi } from 'vitest';
import { otelWorkspaceIdForPath } from './otel-workspace';

interface FakeSlot {
  repositoryId: string;
  slotId: number;
  occupancyKey?: string | null;
  sessionCreatedAt?: Date | null;
  workDir: string | null;
  worktreePath: string | null;
  branch: string | null;
  suffix: string | null;
  workUnitId: string | null;
  attemptId: string | null;
  active: boolean;
  updatedAt: number;
}

interface FakeSessionRow {
  repositoryId: string;
  sessionKey: string;
  agentId: number;
  timestamp: number;
}

const repos = [{ id: 'repo-1', path: '/home/user/project' }];
let slots: FakeSlot[] = [];
let sessionEvents: FakeSessionRow[] = [];

interface FakeBinding {
  repositoryId: string;
  agentTool: string;
  sessionId: string;
  subagentId: string;
  kind: string;
  slotId: number;
  occupancyKey: string | null;
  branch: string | null;
  at: Date;
}
let bindings: FakeBinding[] = [];

function findSessionRow(
  rows: FakeSessionRow[],
  where: { repositoryId: string; sessionKey: string },
): FakeSessionRow | null {
  return (
    rows
      .filter(
        (row) =>
          row.repositoryId === where.repositoryId && row.sessionKey === where.sessionKey,
      )
      .sort((a, b) => a.timestamp - b.timestamp)[0] ?? null
  );
}

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findMany: vi.fn(async () => repos),
      findUnique: vi.fn(async ({ where }: { where: { path: string } }) =>
        repos.find((r) => r.path === where.path) ?? null,
      ),
    },
    agentSessionEvent: {
      findFirst: vi.fn(
        async ({ where }: { where: { repositoryId: string; sessionKey: string } }) =>
          findSessionRow(sessionEvents, where),
      ),
    },
    sessionSlotBinding: {
      findMany: vi.fn(
        async ({ where }: { where: { repositoryId: string; sessionId?: string; kind?: string; at: { lte: Date } } }) =>
          bindings.filter(
            (b) =>
              b.repositoryId === where.repositoryId &&
              (where.sessionId === undefined || b.sessionId === where.sessionId) &&
              (where.kind === undefined || b.kind === where.kind) &&
              b.at <= where.at.lte,
          ),
      ),
    },
    workAttempt: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    agentSlot: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ('repositoryId' in where) {
          return slots.filter(
            (s) =>
              s.repositoryId === where.repositoryId &&
              (where.active === undefined || s.active === where.active),
          );
        }
        // OR query used by resolveSlotByWorkspace / resolveRepositoryByWorkspaceId
        return slots.filter((s) => s.workDir || s.worktreePath);
      }),
      findFirst: vi.fn(
        async ({ where }: { where: { repositoryId: string; active: boolean } }) => {
          const filtered = slots
            .filter((s) => s.repositoryId === where.repositoryId && s.active === where.active)
            .sort((a, b) => b.updatedAt - a.updatedAt);
          return filtered[0] ?? null;
        },
      ),
    },
  },
}));

const { resolveSessionContext } = await import('./otel-ingest');

function makeSlot(overrides: Partial<FakeSlot>): FakeSlot {
  return {
    repositoryId: 'repo-1',
    slotId: 1,
    workDir: null,
    worktreePath: null,
    branch: null,
    suffix: null,
    workUnitId: null,
    attemptId: null,
    occupancyKey: null,
    sessionCreatedAt: null,
    active: true,
    updatedAt: 0,
    ...overrides,
  };
}

const MAIN = '/home/user/project';
const SLOT_2 = '/home/user/worktrees/project-abcd-har-agent-2-xyz';

beforeEach(() => {
  slots = [];
  sessionEvents = [];
  bindings = [];
});

describe('resolveSessionContext — no guessing (ADR 0003)', () => {
  it('places a main-checkout record in the main checkout even when exactly one slot is active', async () => {
    slots = [makeSlot({ slotId: 2, workDir: SLOT_2, worktreePath: SLOT_2, branch: 'feat/x' })];

    const { context } = await resolveSessionContext({}, { 'gen_ai.client.workspace': MAIN });

    expect(context).toMatchObject({ repositoryId: 'repo-1', agentId: 0, workDir: MAIN, branch: undefined });
    expect(context?.workspaceSlot).toBeUndefined();
  });

  it('places it in the main checkout with several active slots, or none', async () => {
    slots = [
      makeSlot({ slotId: 2, workDir: '/home/user/worktrees/project-a', updatedAt: 1 }),
      makeSlot({ slotId: 3, workDir: '/home/user/worktrees/project-b', updatedAt: 2 }),
    ];
    expect((await resolveSessionContext({}, { 'gen_ai.client.workspace': MAIN })).context?.agentId).toBe(0);
    slots = [];
    expect((await resolveSessionContext({}, { 'gen_ai.client.workspace': MAIN })).context?.agentId).toBe(0);
  });

  it('ignores the slot of the session\'s first event', async () => {
    slots = [makeSlot({ slotId: 4, workDir: '/home/user/worktrees/project-a' })];
    sessionEvents = [{ repositoryId: 'repo-1', sessionKey: 'session-uuid', agentId: 4, timestamp: 1 }];

    const { context } = await resolveSessionContext(
      {},
      { 'gen_ai.client.workspace': MAIN, 'session.id': 'session-uuid', 'otelhook.provider.id': 'claude-code' },
    );

    expect(context).toMatchObject({ sessionKey: 'session-uuid', agentId: 0, agentTool: 'claude_code' });
  });

  it('follows the session\'s binding timeline at the record\'s time', async () => {
    slots = [makeSlot({ slotId: 4, workDir: '/home/user/worktrees/project-a', branch: 'b4', occupancyKey: 'occ-4' })];
    bindings = [
      {
        repositoryId: 'repo-1',
        agentTool: 'claude_code',
        sessionId: 'session-uuid',
        subagentId: '',
        kind: 'launch',
        slotId: 4,
        occupancyKey: 'occ-4',
        branch: 'b4',
        at: new Date('2026-11-12T10:00:00Z'),
      },
    ];
    const attrs = {
      'gen_ai.client.workspace': MAIN,
      'otelhook.session.id': 'session-uuid',
      'session.id': 'har-session-key',
      'otelhook.provider.id': 'claude-code',
    };

    const before = await resolveSessionContext({}, attrs, { at: new Date('2026-11-12T09:59:00Z') });
    const after = await resolveSessionContext({}, attrs, { at: new Date('2026-11-12T10:01:00Z') });

    expect(before.context?.agentId).toBe(0);
    expect(after.context).toMatchObject({
      agentId: 4,
      branch: 'b4',
      occupancyKey: 'occ-4',
      sessionRef: { agentTool: 'claude_code', sessionId: 'session-uuid' },
    });
  });

  it('takes a tool event that targeted a slot worktree as evidence for that slot', async () => {
    slots = [makeSlot({ slotId: 2, workDir: SLOT_2, worktreePath: SLOT_2, branch: 'feat/x', occupancyKey: 'occ-2' })];

    const resolved = await resolveSessionContext(
      {},
      {
        'gen_ai.client.workspace': MAIN,
        'otelhook.session.id': 's-1',
        'otelhook.provider.id': 'claude-code',
        'vcs.ref.head.name': 'feat/x',
      },
    );

    expect(resolved.context).toMatchObject({ agentId: 2, branch: 'feat/x', occupancyKey: 'occ-2' });
    expect(resolved.evidence).toEqual([
      { kind: 'observed', slot: expect.objectContaining({ slotId: 2, occupancyKey: 'occ-2' }) },
    ]);
  });

  it('does not take the main checkout\'s own branch as slot evidence', async () => {
    slots = [makeSlot({ slotId: 2, workDir: SLOT_2, branch: 'feat/x' })];

    const resolved = await resolveSessionContext(
      {},
      { 'gen_ai.client.workspace': MAIN, 'otelhook.session.id': 's-1', 'vcs.ref.head.name': 'main' },
    );

    expect(resolved.context?.agentId).toBe(0);
    expect(resolved.evidence).toEqual([]);
  });

  it('takes a session-cwd target as workspace evidence that never overrides a later launch elsewhere', async () => {
    slots = [
      makeSlot({ slotId: 2, workDir: SLOT_2, worktreePath: SLOT_2, branch: 'feat/x', occupancyKey: 'occ-2' }),
      makeSlot({ slotId: 3, workDir: '/home/user/worktrees/project-c', branch: 'feat/y', occupancyKey: 'occ-3' }),
    ];
    const attrs = {
      'gen_ai.client.workspace': MAIN,
      'otelhook.session.id': 's-1',
      'otelhook.provider.id': 'claude-code',
      'vcs.ref.head.name': 'feat/x',
      'otelhook.target.source': 'session-cwd',
    };
    const at = new Date('2026-11-12T10:30:00Z');
    bindings = [
      { repositoryId: 'repo-1', agentTool: 'claude_code', sessionId: 's-1', subagentId: '', kind: 'workspace', slotId: 2, occupancyKey: 'occ-2', branch: 'feat/x', at: new Date('2026-11-12T10:00:00Z') },
      { repositoryId: 'repo-1', agentTool: 'claude_code', sessionId: 's-1', subagentId: '', kind: 'launch', slotId: 3, occupancyKey: 'occ-3', branch: 'feat/y', at: new Date('2026-11-12T10:10:00Z') },
    ];

    const resolved = await resolveSessionContext({}, attrs, { at });

    expect(resolved.evidence).toEqual([{ kind: 'workspace', slot: expect.objectContaining({ slotId: 2 }) }]);
    expect(resolved.context?.agentId).toBe(3);
  });

  it('maps the opaque workspace id of a slot worktree to that slot, as workspace evidence', async () => {
    slots = [
      makeSlot({ slotId: 5, workDir: SLOT_2, worktreePath: SLOT_2, branch: 'fix/y', workUnitId: 'WU-2', occupancyKey: 'occ-5' }),
    ];

    const inSlot = await resolveSessionContext({}, { 'otelhook.workspace.id': otelWorkspaceIdForPath(SLOT_2) });
    const inMain = await resolveSessionContext({}, { 'otelhook.workspace.id': otelWorkspaceIdForPath(MAIN) });

    expect(inSlot.context).toMatchObject({ agentId: 5, branch: 'fix/y', workUnitId: 'WU-2' });
    expect(inSlot.context?.workspaceSlot).toMatchObject({ slotId: 5, occupancyKey: 'occ-5' });
    expect(inMain.context).toMatchObject({ repositoryId: 'repo-1', agentId: 0, workDir: MAIN });
  });

  it('places a record in the slot whose worktree the session runs in', async () => {
    slots = [makeSlot({ slotId: 2, workDir: SLOT_2, worktreePath: SLOT_2, branch: 'feat/x' })];
    sessionEvents = [{ repositoryId: 'repo-1', sessionKey: 'feat/x', agentId: 5, timestamp: 1 }];

    const { context } = await resolveSessionContext({}, { 'gen_ai.client.workspace': SLOT_2 });

    expect(context).toMatchObject({ agentId: 2, workspaceSlot: { slotId: 2 } });
  });

  it('refuses harSessionKey-only attribution when agent tool is unknown', async () => {
    const { context, reason } = await resolveSessionContext(
      {
        'har.session_key': 'main-abcd-har-agent-1-xy12',
        'har.repo_path': '/home/user/project',
      },
      { 'gen_ai.client.workspace': '/tmp/unrelated-workspace' },
    );

    expect(context).toBeNull();
    expect(reason).toMatch(/unknown agent tool/i);
  });
});
