import {
  buildSessionHistoryGraph,
  commitNodeId,
  HANDOFF_LIFECYCLE_COPY,
  provenanceForNode,
  snapshotNodeId,
} from '../packages/schemas/src/session-history';

const TREE = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const COMMIT_A = 'c'.repeat(40);
const COMMIT_B = 'd'.repeat(40);

describe('session history graph', () => {
  it('renders a validated but uncommitted tree as a pending snapshot', () => {
    const graph = buildSessionHistoryGraph({
      snapshots: [
        {
          validationId: '11111111-1111-4111-8111-111111111111',
          treeHash: TREE,
          headSha: BASE,
          branch: 'feat/session',
          agentId: 1,
          status: 'pass',
          full: true,
          runId: '22222222-2222-4222-8222-222222222222',
          changedFileCount: 1,
          createdAt: '2026-08-31T10:00:00.000Z',
        },
      ],
      bindings: [],
      slots: [
        {
          agentId: 1,
          branch: 'feat/session',
          baseCommit: BASE,
          active: true,
          workUnitId: '191',
          attemptId: '33333333-3333-4333-8333-333333333333',
        },
      ],
    });

    const snapshot = graph.nodes.find((node) => node.id === snapshotNodeId(TREE));
    expect(snapshot).toMatchObject({
      kind: 'snapshot',
      pending: true,
      treeHash: TREE,
      headSha: BASE,
      full: true,
      handoff: 'active',
    });
    expect(graph.edges).toContainEqual({
      id: `based-on:${commitNodeId(BASE)}->${snapshotNodeId(TREE)}`,
      source: commitNodeId(BASE),
      target: snapshotNodeId(TREE),
      kind: 'based-on',
    });
    expect(provenanceForNode(snapshot!)).toEqual({
      commit: null,
      contentSnapshot: TREE,
      basedOn: BASE,
      verifiedByRun: '22222222-2222-4222-8222-222222222222',
    });
  });

  it('keeps two commits that share one content snapshot', () => {
    const graph = buildSessionHistoryGraph({
      snapshots: [
        {
          validationId: '11111111-1111-4111-8111-111111111111',
          treeHash: TREE,
          headSha: BASE,
          branch: 'feat/session',
          status: 'pass',
          full: true,
          runId: '22222222-2222-4222-8222-222222222222',
          changedFileCount: 2,
          createdAt: '2026-08-31T10:00:00.000Z',
        },
      ],
      bindings: [
        {
          bindingId: '44444444-4444-4444-8444-444444444444',
          validationId: '11111111-1111-4111-8111-111111111111',
          treeHash: TREE,
          commitSha: COMMIT_A,
          parents: [BASE],
          refs: ['feat/session'],
          message: 'feat: first location',
          createdAt: '2026-08-31T10:05:00.000Z',
        },
        {
          bindingId: '55555555-5555-4555-8555-555555555555',
          validationId: '11111111-1111-4111-8111-111111111111',
          treeHash: TREE,
          commitSha: COMMIT_B,
          parents: [BASE],
          refs: ['feat/session-rebased'],
          message: 'feat: same tree after rebase',
          createdAt: '2026-08-31T11:00:00.000Z',
        },
      ],
      slots: [{ agentId: 1, branch: 'feat/session', active: false }],
    });

    expect(graph.nodes.filter((node) => node.kind === 'snapshot')).toHaveLength(0);
    const first = graph.nodes.find((node) => node.commitSha === COMMIT_A);
    const second = graph.nodes.find((node) => node.commitSha === COMMIT_B);
    expect(first?.matchingCommitCount).toBe(2);
    expect(second?.matchingCommitCount).toBe(2);
    expect(first?.treeHash).toBe(TREE);
    expect(second?.status).toBe('pass');
    expect(first?.handoff).toBe('retained');
    expect(graph.edges.some((edge) => edge.kind === 'parent' && edge.target === commitNodeId(COMMIT_A))).toBe(
      true,
    );
    expect(HANDOFF_LIFECYCLE_COPY).toMatch(/does not copy changes/);
  });
});
