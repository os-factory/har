import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Slot occupancy identity (#316) — the questions this line's gate keeps asking.
 *
 * A slot number is a workstation; a working session is one occupancy of one
 * worktree. `complete` / `teardown` then `launch` reuses the number and must
 * mint a NEW occupancy. `--resume` continues the same one.
 *
 * Station tags (`har line gate S0` … `S2`) map to the describe blocks below;
 * each station's gate runs its own stage plus every earlier station's.
 */

const agentSlotFindUnique = vi.fn();
const agentSlotUpsert = vi.fn();
const trajectoryGroupBy = vi.fn();
const usageFindMany = vi.fn();
const slotFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    agentSlot: {
      findUnique: (...args: unknown[]) => agentSlotFindUnique(...args),
      upsert: (...args: unknown[]) => agentSlotUpsert(...args),
      findMany: (...args: unknown[]) => slotFindMany(...args),
    },
    agentTrajectoryRecord: {
      groupBy: (...args: unknown[]) => trajectoryGroupBy(...args),
    },
    agentSessionUsage: {
      findMany: (...args: unknown[]) => usageFindMany(...args),
    },
    repository: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock('@/server/git-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
}));

vi.mock('@/server/worktree-cleanup', () => ({
  cleanupSessionWorktrees: () => [],
}));

import { deriveOccupancyKey, isNewOccupancy } from './occupancy';
import { buildAgentSlotSyncFields } from './slot-sync-fields';
import { syncSlots } from './repositories';
import { listTrajectoryStreams } from './trajectory-ledger';
import { listSessionUsageForSlot } from './usage';

/** One occupancy of slot 1, as the harness reports it. */
function occupancy(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 1,
    active: true,
    harnessUsage: 'cli' as const,
    branch: 'main-aaaa-har-agent-1-oldx',
    worktreePath: '/home/dev/worktrees/main-aaaa-har-agent-1-oldx',
    workDir: '/home/dev/worktrees/main-aaaa-har-agent-1-oldx',
    sessionCreatedAt: '2026-08-01T10:00:00.000Z',
    attemptId: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

const OCCUPANCY_B = occupancy({
  branch: 'main-bbbb-har-agent-1-newy',
  worktreePath: '/home/dev/worktrees/main-bbbb-har-agent-1-newy',
  workDir: '/home/dev/worktrees/main-bbbb-har-agent-1-newy',
  sessionCreatedAt: '2026-08-02T09:00:00.000Z',
  attemptId: '22222222-2222-4222-8222-222222222222',
});

beforeEach(() => {
  agentSlotFindUnique.mockReset();
  agentSlotUpsert.mockReset();
  trajectoryGroupBy.mockReset();
  usageFindMany.mockReset();
  slotFindMany.mockReset();
  agentSlotUpsert.mockResolvedValue({});
  trajectoryGroupBy.mockResolvedValue([]);
  usageFindMany.mockResolvedValue([]);
});

describe('S0 — a relaunched slot does not keep the previous occupancy', () => {
  it('derives a distinct key per occupancy and none when idle', () => {
    const a = deriveOccupancyKey(occupancy());
    const b = deriveOccupancyKey(OCCUPANCY_B);

    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    expect(a).not.toEqual(b);
    expect(deriveOccupancyKey(occupancy({ active: false }))).toBeNull();
  });

  it('keeps the same key when the same worktree is resumed', () => {
    // --resume / recover continues the occupancy: same attempt, same key.
    const first = deriveOccupancyKey(occupancy());
    const resumed = deriveOccupancyKey(occupancy({ dirty: true, ahead: 3 }));

    expect(resumed).toEqual(first);
    expect(isNewOccupancy(first, resumed)).toBe(false);
  });

  it('falls back to branch + session start when no attempt is bound', () => {
    const a = deriveOccupancyKey(occupancy({ attemptId: undefined }));
    const b = deriveOccupancyKey({ ...OCCUPANCY_B, attemptId: undefined });

    expect(a).toBeTruthy();
    expect(a).not.toEqual(b);
  });

  it('nulls occupancyKey on the sync that reports the slot idle', () => {
    const fields = buildAgentSlotSyncFields(occupancy({ active: false }) as never);

    expect(fields.occupancyKey).toBeNull();
    expect(fields.workDir).toBeNull();
  });

  it('clears purpose when a new occupancy takes the slot', async () => {
    // Occupancy A is stored; the harness now reports occupancy B in slot 1.
    agentSlotFindUnique.mockResolvedValue({
      occupancyKey: deriveOccupancyKey(occupancy()),
    });

    await syncSlots('repo-1', { slots: [OCCUPANCY_B], generatedAt: new Date().toISOString() });

    const { update } = agentSlotUpsert.mock.calls[0][0];
    expect(update.purpose).toBeNull();
    expect(update.occupancyKey).toEqual(deriveOccupancyKey(OCCUPANCY_B));
  });

  it('clears purpose when the slot goes idle', async () => {
    agentSlotFindUnique.mockResolvedValue({
      occupancyKey: deriveOccupancyKey(occupancy()),
    });

    await syncSlots('repo-1', {
      slots: [occupancy({ active: false })],
      generatedAt: new Date().toISOString(),
    });

    const { update } = agentSlotUpsert.mock.calls[0][0];
    expect(update.purpose).toBeNull();
    expect(update.occupancyKey).toBeNull();
  });

  it('leaves purpose untouched while the same occupancy keeps working', async () => {
    agentSlotFindUnique.mockResolvedValue({
      occupancyKey: deriveOccupancyKey(occupancy()),
    });

    await syncSlots('repo-1', {
      slots: [occupancy({ dirty: true })],
      generatedAt: new Date().toISOString(),
    });

    const { update } = agentSlotUpsert.mock.calls[0][0];
    // undefined = "leave the column unchanged" in Prisma.
    expect(update.purpose).toBeUndefined();
  });
});

describe('S1 — trajectory and usage are scoped to the occupancy, not the slot id', () => {
  it('filters trajectory streams by occupancyKey when the slot has one', async () => {
    await listTrajectoryStreams('repo-1', 1, 'attempt::occupancy-b');

    expect(trajectoryGroupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { repositoryId: 'repo-1', agentId: 1, occupancyKey: 'attempt::occupancy-b' },
      }),
    );
  });

  it('filters usage rows by occupancyKey when the slot has one', async () => {
    await listSessionUsageForSlot('repo-1', 1, 'attempt::occupancy-b');

    expect(usageFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { repositoryId: 'repo-1', agentId: 1, occupancyKey: 'attempt::occupancy-b' },
      }),
    );
  });

  it('falls back to slot-wide listing for an idle slot with no occupancy', async () => {
    // Nothing to scope to — an idle slot page still shows its history rather
    // than an empty panel.
    await listTrajectoryStreams('repo-1', 1, null);
    await listSessionUsageForSlot('repo-1', 1, null);

    expect(trajectoryGroupBy.mock.calls[0][0].where).toEqual({ repositoryId: 'repo-1', agentId: 1 });
    expect(usageFindMany.mock.calls[0][0].where).toEqual({ repositoryId: 'repo-1', agentId: 1 });
  });
});

describe('S2 — ingest does not merge a new occupancy into the previous session', () => {
  it('prefers the matched worktree over a stale har.session_key', async () => {
    // The global otel-hook config still carries occupancy A's session key while
    // the agent is demonstrably working in occupancy B's worktree.
    slotFindMany.mockResolvedValue([
      {
        repositoryId: 'repo-1',
        slotId: 1,
        workDir: OCCUPANCY_B.workDir,
        worktreePath: OCCUPANCY_B.worktreePath,
        branch: OCCUPANCY_B.branch,
        suffix: 'newy',
        workUnitId: '316',
        attemptId: OCCUPANCY_B.attemptId,
        occupancyKey: deriveOccupancyKey(OCCUPANCY_B),
      },
    ]);

    const { resolveSessionContext } = await import('./otel-ingest');
    const { context } = await resolveSessionContext(
      { 'har.session_key': 'main-aaaa-har-agent-1-oldx' },
      {
        'gen_ai.client.workspace': OCCUPANCY_B.workDir,
        'gen_ai.agent.name': 'claude_code',
      },
    );

    expect(context?.sessionKey).toBe(OCCUPANCY_B.branch);
    expect(context?.sessionKey).not.toBe('main-aaaa-har-agent-1-oldx');
    expect(context?.occupancyKey).toBe(deriveOccupancyKey(OCCUPANCY_B));
  });

  it('stamps the occupancy on the resolved context so records carry it', async () => {
    slotFindMany.mockResolvedValue([
      {
        repositoryId: 'repo-1',
        slotId: 1,
        workDir: OCCUPANCY_B.workDir,
        worktreePath: OCCUPANCY_B.worktreePath,
        branch: OCCUPANCY_B.branch,
        suffix: 'newy',
        workUnitId: null,
        attemptId: null,
        occupancyKey: 'attempt::occupancy-b',
      },
    ]);

    const { resolveSessionContext } = await import('./otel-ingest');
    const { context } = await resolveSessionContext(
      {},
      {
        'gen_ai.client.workspace': `${OCCUPANCY_B.workDir}/control`,
        'gen_ai.agent.name': 'claude_code',
      },
    );

    expect(context?.occupancyKey).toBe('attempt::occupancy-b');
  });
});
