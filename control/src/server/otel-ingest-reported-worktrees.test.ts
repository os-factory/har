import { beforeEach, describe, expect, it, vi } from 'vitest';
import { otelWorkspaceIdForPath } from './otel-workspace';

/**
 * Mission Control in docker (FE-2058): the container mounts only `/data`, so a
 * repository's `.git/worktrees` is not visible. Sessions in a plain
 * `git worktree add` worktree report only a hashed workspace id, which must
 * still be placed — from the listing the CLI reports — and never dropped.
 *
 * The repository path below does not exist on this machine, exactly as a host
 * path does not exist inside the container.
 */

const MAIN = '/host-only/home/user/project';
const WT = '/host-only/home/user/project-feat';
const SID = 'sess-wt-1';

const state = vi.hoisted(() => ({
  repo: { id: 'repo-1', path: '', reportedWorktrees: null as unknown, reportedWorktreesAt: null as Date | null },
  bindings: [] as Array<Record<string, unknown>>,
  observations: [] as Array<Record<string, unknown>>,
  parked: [] as Array<{ id: string; signal: string; sessionId: string | null; payload: unknown; createdAt: Date }>,
}));

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: {
      findMany: async () => [state.repo],
      findUnique: async ({ where }: { where: { id?: string } }) => (where.id === state.repo.id ? state.repo : null),
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(state.repo, data),
    },
    agentSlot: { findMany: async () => [], findUnique: async () => ({ purpose: 'set' }) },
    sessionSlotBinding: {
      findMany: async ({ where, distinct }: { where: { occupancyKey?: { startsWith: string } }; distinct?: string[] }) => {
        if (!where.occupancyKey) return [];
        const keys = state.bindings
          .map((binding) => binding.occupancyKey as string | null)
          .filter((key): key is string => Boolean(key?.startsWith(where.occupancyKey!.startsWith)));
        return (distinct ? [...new Set(keys)] : keys).map((occupancyKey) => ({ occupancyKey }));
      },
      findFirst: async ({ where }: { where: { sessionId: string } }) => {
        const hit = state.bindings.find((binding) => binding.sessionId === where.sessionId);
        return hit ? { repositoryId: hit.repositoryId } : null;
      },
      updateMany: async ({ where, data }: { where: { occupancyKey: string }; data: Record<string, unknown> }) => {
        const rows = state.bindings.filter((binding) => binding.occupancyKey === where.occupancyKey);
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      },
    },
    usageObservation: {
      findFirst: async ({ where }: { where: { sessionId: string } }) => {
        const hit = state.observations.find((observation) => observation.sessionId === where.sessionId);
        return hit ? { repositoryId: hit.repositoryId } : null;
      },
    },
    workAttempt: { findMany: async () => [], findFirst: async () => null },
    agentSessionSpan: { findFirst: async () => null },
    $queryRaw: async () => [],
    parkedOtelRecord: {
      create: async ({ data }: { data: { signal: string; sessionId: string | null; payload: unknown } }) => {
        const row = { id: `p${state.parked.length + 1}`, createdAt: new Date(), ...data };
        state.parked.push(row);
        return row;
      },
      deleteMany: async ({ where }: { where: { id?: string | { in: string[] } } }) => {
        const ids = typeof where.id === 'string' ? [where.id] : (where.id?.in ?? []);
        const before = state.parked.length;
        state.parked = state.parked.filter((row) => !ids.includes(row.id));
        return { count: before - state.parked.length };
      },
      count: async () => state.parked.length,
      findMany: async ({ where }: { where: { sessionId?: { in: string[] } } }) =>
        state.parked.filter((row) => !where.sessionId || (row.sessionId && where.sessionId.in.includes(row.sessionId))),
    },
  },
}));

vi.mock('@/server/session-attribution', () => ({
  recordBindings: async (repositoryId: string, bindings: Array<Record<string, unknown>>) => {
    for (const binding of bindings) state.bindings.push({ repositoryId, ...binding });
    return { synced: bindings.length, created: bindings.length };
  },
  recordObservations: async (repositoryId: string, observations: Array<Record<string, unknown>>) => {
    for (const observation of observations) state.observations.push({ repositoryId, ...observation });
    return { synced: observations.length, created: observations.length };
  },
  recordReportedUsage: async () => ({}),
}));

vi.mock('@/server/trajectory-ledger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/server/trajectory-ledger')>()),
  appendTrajectoryRecord: async (_repositoryId: string, record: Record<string, unknown>) => ({ record, inserted: true }),
}));

import { clearLinkedWorktreeCache } from './git-worktrees';
import { ingestOtelLogsJson, ingestOtelTracesJson } from './otel-ingest';
import { syncReportedWorktrees } from './reported-worktrees';

function attrs(map: Record<string, string | number>) {
  return Object.entries(map).map(([key, value]) => ({
    key,
    value: typeof value === 'number' ? { intValue: value } : { stringValue: value },
  }));
}

/** An otel-hook generation span of `SID`, reported from the cwd `cwd` (as a hashed workspace id only). */
function generationFrom(cwd: string, generationId: string) {
  return {
    resourceSpans: [
      {
        resource: { attributes: attrs({ 'otelhook.provider.id': 'claude-code' }) },
        scopeSpans: [
          {
            spans: [
              {
                traceId: 'b'.repeat(32),
                spanId: Buffer.from(generationId).toString('hex').padEnd(16, '0').slice(-16),
                name: 'generation claude-opus-5-5',
                startTimeUnixNano: '1762941600000000000',
                endTimeUnixNano: '1762941630000000000',
                attributes: attrs({
                  'otelhook.workspace.id': otelWorkspaceIdForPath(cwd),
                  'otelhook.session.id': SID,
                  'otelhook.generation.id': generationId,
                  'otelhook.usage.temporality': 'delta',
                  'gen_ai.response.model': 'claude-opus-5-5',
                  'gen_ai.usage.input_tokens': 100,
                  'gen_ai.usage.output_tokens': 10,
                }),
              },
            ],
          },
        ],
      },
    ],
  };
}

const listing = (worktrees: Array<{ path: string; branch: string | null }>) => ({
  worktrees: worktrees.map((worktree) => ({ ...worktree, head: 'abc123' })),
  generatedAt: '2025-11-12T10:05:00.000Z',
});

beforeEach(() => {
  clearLinkedWorktreeCache();
  state.repo = { id: 'repo-1', path: MAIN, reportedWorktrees: null, reportedWorktreesAt: null };
  state.bindings = [];
  state.observations = [];
  state.parked = [];
});

describe('Mission Control without a visible .git (docker)', () => {
  it('places a plain-worktree session from the listing the CLI reported', async () => {
    await syncReportedWorktrees('repo-1', listing([{ path: WT, branch: 'feat' }]));

    const result = await ingestOtelTracesJson(generationFrom(WT, 'gen-1'));

    expect(result).toMatchObject({ accepted: 1, dropped: 0 });
    expect(state.bindings).toEqual([
      expect.objectContaining({ repositoryId: 'repo-1', sessionId: SID, slotId: 0, occupancyKey: `worktree:${WT}`, branch: 'feat' }),
    ]);
    expect(state.observations).toEqual([expect.objectContaining({ repositoryId: 'repo-1', sessionId: SID, tokensInput: 100 })]);
  });

  it('keeps a known session reporting from an unlisted place in its repository, in an unresolved-place bucket', async () => {
    // The session's first request came from the main checkout.
    const first = await ingestOtelTracesJson(generationFrom(MAIN, 'gen-main'));
    expect(first).toMatchObject({ accepted: 1 });
    expect(state.observations).toHaveLength(1);

    // It then entered a worktree (EnterWorktree) no listing names yet.
    const result = await ingestOtelTracesJson(generationFrom(WT, 'gen-wt'));

    expect(result).toMatchObject({ accepted: 1, dropped: 0 });
    expect(state.observations.map((o) => o.observationKey)).toEqual(['gen-main', 'gen-wt']);
    expect(state.bindings).toEqual([
      expect.objectContaining({
        repositoryId: 'repo-1',
        slotId: 0,
        kind: 'workspace',
        occupancyKey: `unresolved-workspace:${otelWorkspaceIdForPath(WT)}`,
      }),
    ]);

    // A later listing names the place: the binding becomes that worktree's.
    const synced = await syncReportedWorktrees('repo-1', listing([{ path: WT, branch: 'feat' }]));
    expect(synced).toMatchObject({ renamedBindings: 1 });
    expect(state.bindings[0]).toMatchObject({ occupancyKey: `worktree:${WT}`, branch: 'feat' });
  });

  it('parks the usage of a session that started in an unlisted worktree and replays it when the listing arrives', async () => {
    const result = await ingestOtelTracesJson(generationFrom(WT, 'gen-1'));

    expect(result).toMatchObject({ accepted: 0, dropped: 0, parked: 1 });
    expect(state.observations).toHaveLength(0);
    expect(state.parked).toHaveLength(1);

    const synced = await syncReportedWorktrees('repo-1', listing([{ path: WT, branch: 'feat' }]));

    expect(synced).toMatchObject({ replayed: 1, remaining: 0 });
    expect(state.parked).toHaveLength(0);
    expect(state.observations).toEqual([expect.objectContaining({ repositoryId: 'repo-1', sessionId: SID, observationKey: 'gen-1' })]);
    expect(state.bindings).toEqual([expect.objectContaining({ occupancyKey: `worktree:${WT}`, branch: 'feat' })]);
    expect((state.bindings[0].at as Date).toISOString()).toBe('2025-11-12T10:00:30.000Z');
  });

  it('replays a parked Claude api_request once a later record makes its session known', async () => {
    const apiRequest = {
      resourceLogs: [
        {
          resource: { attributes: attrs({ 'service.name': 'claude-code' }) },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: '1762941600000000000',
                  attributes: attrs({
                    'event.name': 'api_request',
                    'session.id': SID,
                    'otelhook.workspace.id': otelWorkspaceIdForPath(WT),
                    request_id: 'req_1',
                    model: 'claude-opus-5-5',
                    input_tokens: 5,
                    output_tokens: 6,
                  }),
                },
              ],
            },
          ],
        },
      ],
    };
    expect(await ingestOtelLogsJson(apiRequest)).toMatchObject({ accepted: 0, dropped: 0, parked: 1 });

    await ingestOtelTracesJson(generationFrom(MAIN, 'gen-main'));

    expect(state.parked).toHaveLength(0);
    expect(state.observations.map((o) => o.observationKey).sort()).toEqual(['gen-main', 'req_1']);
  });

  it('still drops a record that carries no usage and names no known place', async () => {
    const result = await ingestOtelTracesJson({
      resourceSpans: [
        {
          resource: { attributes: attrs({ 'otelhook.provider.id': 'claude-code' }) },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'c'.repeat(32),
                  spanId: '9'.repeat(16),
                  name: 'tool.call',
                  startTimeUnixNano: '1762941600000000000',
                  attributes: attrs({ 'otelhook.workspace.id': otelWorkspaceIdForPath('/elsewhere'), 'otelhook.session.id': 'other' }),
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result).toMatchObject({ accepted: 0, dropped: 1 });
    expect(state.parked).toHaveLength(0);
  });
});
