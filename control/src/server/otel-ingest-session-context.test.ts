import { beforeEach, describe, expect, it, vi } from 'vitest';
import { otelWorkspaceIdForPath } from './otel-workspace';

interface FakeSlot {
  repositoryId: string;
  slotId: number;
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
    active: true,
    updatedAt: 0,
    ...overrides,
  };
}

describe('resolveSessionContext — Cursor on the main checkout', () => {
  beforeEach(() => {
    slots = [];
    sessionEvents = [];
  });

  it('attributes to the one active worktree when correlation is unambiguous', async () => {
    slots = [
      makeSlot({
        slotId: 2,
        workDir: '/home/user/worktrees/project-abcd-har-agent-2-xyz',
        worktreePath: '/home/user/worktrees/project-abcd-har-agent-2-xyz',
        branch: 'feat/x',
        suffix: 'xyz',
        workUnitId: 'WU-1',
        attemptId: 'AT-1',
        updatedAt: 1,
      }),
    ];

    const { context } = await resolveSessionContext(
      {},
      { 'gen_ai.client.workspace': '/home/user/project' },
    );

    expect(context).toMatchObject({
      repositoryId: 'repo-1',
      agentId: 2,
      workDir: '/home/user/worktrees/project-abcd-har-agent-2-xyz',
      branch: 'feat/x',
      suffix: 'xyz',
      workUnitId: 'WU-1',
      attemptId: 'AT-1',
    });
  });

  it('falls back to the raw workspace path when two slots are active (ambiguous)', async () => {
    slots = [
      makeSlot({ slotId: 2, workDir: '/home/user/worktrees/project-a', updatedAt: 1 }),
      makeSlot({ slotId: 3, workDir: '/home/user/worktrees/project-b', updatedAt: 2 }),
    ];

    const { context } = await resolveSessionContext(
      {},
      { 'gen_ai.client.workspace': '/home/user/project' },
    );

    expect(context).toMatchObject({
      repositoryId: 'repo-1',
      agentId: 3, // most recently updated active slot — same guess as before this fix
      workDir: '/home/user/project',
      branch: undefined,
      workUnitId: undefined,
      attemptId: undefined,
    });
  });

  it('falls back to the raw workspace path when no slot is active', async () => {
    slots = [];

    const { context } = await resolveSessionContext(
      {},
      { 'gen_ai.client.workspace': '/home/user/project' },
    );

    expect(context).toMatchObject({
      repositoryId: 'repo-1',
      agentId: 1,
      workDir: '/home/user/project',
    });
  });

  it('applies the same unambiguous correlation via the opaque workspace id', async () => {
    slots = [
      makeSlot({
        slotId: 5,
        workDir: '/home/user/worktrees/project-abcd-har-agent-5-xyz',
        worktreePath: '/home/user/worktrees/project-abcd-har-agent-5-xyz',
        branch: 'fix/y',
        workUnitId: 'WU-2',
        updatedAt: 1,
      }),
    ];
    const workspaceId = otelWorkspaceIdForPath('/home/user/project');

    const { context } = await resolveSessionContext(
      {},
      { 'otelhook.workspace.id': workspaceId },
    );

    expect(context).toMatchObject({
      repositoryId: 'repo-1',
      agentId: 5,
      workDir: '/home/user/worktrees/project-abcd-har-agent-5-xyz',
      branch: 'fix/y',
      workUnitId: 'WU-2',
    });
  });

  it('keeps a session on the agent id it was first attributed to', async () => {
    slots = [
      makeSlot({ slotId: 4, workDir: '/home/user/worktrees/project-a', updatedAt: 1 }),
      makeSlot({ slotId: 5, workDir: '/home/user/worktrees/project-b', updatedAt: 2 }),
    ];
    sessionEvents = [
      {
        repositoryId: 'repo-1',
        sessionKey: 'session-uuid',
        agentId: 4,
        timestamp: 1,
      },
    ];

    const { context } = await resolveSessionContext(
      {},
      {
        'gen_ai.client.workspace': '/home/user/project',
        'session.id': 'session-uuid',
        'otelhook.provider.id': 'claude-code',
      },
    );

    expect(context).toMatchObject({
      sessionKey: 'session-uuid',
      agentId: 4,
      agentTool: 'claude_code',
    });
  });

  it('does not let a pin override the slot whose worktree the session ran in', async () => {
    slots = [
      makeSlot({
        slotId: 2,
        workDir: '/home/user/worktrees/project-abcd-har-agent-2-xyz',
        worktreePath: '/home/user/worktrees/project-abcd-har-agent-2-xyz',
        branch: 'feat/x',
        updatedAt: 1,
      }),
    ];
    sessionEvents = [
      { repositoryId: 'repo-1', sessionKey: 'feat/x', agentId: 5, timestamp: 1 },
    ];

    const { context } = await resolveSessionContext(
      {},
      {
        'gen_ai.client.workspace': '/home/user/worktrees/project-abcd-har-agent-2-xyz',
      },
    );

    expect(context).toMatchObject({ agentId: 2 });
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
