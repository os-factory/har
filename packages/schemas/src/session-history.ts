/** Pure session-history graph. No I/O — CLI tests and Mission Control share it. */

export type HistoryNodeKind = 'commit' | 'snapshot';
export type HistoryEdgeKind = 'parent' | 'based-on' | 'verified-as';
export type HistoryHandoff = 'active' | 'retained' | 'unknown';

export interface HistoryCommitBinding {
  bindingId: string;
  validationId: string;
  treeHash: string;
  commitSha: string;
  parents: string[];
  refs: string[];
  message?: string;
  runId?: string;
  createdAt: string;
}

export interface HistorySnapshot {
  validationId: string;
  treeHash: string;
  headSha?: string;
  branch?: string;
  agentId?: number;
  status: 'pass' | 'fail';
  full: boolean;
  runId?: string;
  changedFileCount: number;
  commitSha?: string;
  createdAt: string;
  /** Occupancy that produced the snapshot (#348) — the key into the attempt record. */
  occupancyKey?: string;
}

export interface HistorySlot {
  agentId: number;
  branch?: string | null;
  baseBranch?: string | null;
  baseCommit?: string | null;
  active: boolean;
  purpose?: string | null;
  attemptId?: string | null;
  workUnitId?: string | null;
}

export interface HistoryGraphNode {
  id: string;
  kind: HistoryNodeKind;
  pending: boolean;
  treeHash?: string;
  commitSha?: string;
  headSha?: string;
  branch?: string;
  agentId?: number;
  status?: 'pass' | 'fail';
  full?: boolean;
  runId?: string;
  changedFileCount?: number;
  message?: string;
  refs: string[];
  parents: string[];
  createdAt?: string;
  validationId?: string;
  workUnitId?: string;
  attemptId?: string;
  /** Occupancy that produced this tree (#348); absent for base commits. */
  occupancyKey?: string;
  handoff: HistoryHandoff;
  matchingCommitCount: number;
}

export interface HistoryGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: HistoryEdgeKind;
}

export interface SessionHistoryGraph {
  nodes: HistoryGraphNode[];
  edges: HistoryGraphEdge[];
}

export interface SessionHistoryInput {
  snapshots: HistorySnapshot[];
  bindings: HistoryCommitBinding[];
  slots?: HistorySlot[];
}

export function commitNodeId(sha: string): string {
  return `commit:${sha}`;
}

export function snapshotNodeId(treeHash: string): string {
  return `snapshot:${treeHash}`;
}

function emptyNode(partial: Omit<HistoryGraphNode, 'refs' | 'parents' | 'handoff' | 'matchingCommitCount' | 'pending'> & {
  pending?: boolean;
  refs?: string[];
  parents?: string[];
  handoff?: HistoryHandoff;
  matchingCommitCount?: number;
}): HistoryGraphNode {
  return {
    refs: [],
    parents: [],
    handoff: 'unknown',
    matchingCommitCount: 0,
    pending: false,
    ...partial,
  };
}

function handoffForBranch(branch: string | undefined, slots: HistorySlot[]): HistoryHandoff {
  if (!branch) return 'unknown';
  const matches = slots.filter((slot) => slot.branch === branch);
  if (matches.length === 0) return 'unknown';
  return matches.some((slot) => slot.active) ? 'active' : 'retained';
}

function slotForBranch(branch: string | undefined, slots: HistorySlot[]): HistorySlot | undefined {
  if (!branch) return undefined;
  return slots.find((slot) => slot.branch === branch && slot.active) ?? slots.find((slot) => slot.branch === branch);
}

/**
 * Build a commit-centric graph from exact-tree snapshots and commit bindings.
 *
 * Pending validated trees become dashed snapshot nodes. Once a commit shares
 * that tree, the snapshot stays addressable but the commit is the primary node.
 */
export function buildSessionHistoryGraph(input: SessionHistoryInput): SessionHistoryGraph {
  const slots = input.slots ?? [];
  const nodes = new Map<string, HistoryGraphNode>();
  const edges = new Map<string, HistoryGraphEdge>();

  const addEdge = (source: string, target: string, kind: HistoryEdgeKind) => {
    if (source === target) return;
    const id = `${kind}:${source}->${target}`;
    if (edges.has(id)) return;
    edges.set(id, { id, source, target, kind });
  };

  const ensureCommit = (sha: string, extras: Partial<HistoryGraphNode> = {}) => {
    const id = commitNodeId(sha);
    const existing = nodes.get(id);
    if (existing) {
      nodes.set(id, { ...existing, ...extras, id, kind: 'commit', commitSha: sha, pending: false });
      return nodes.get(id)!;
    }
    const node = emptyNode({
      id,
      kind: 'commit',
      commitSha: sha,
      pending: false,
      ...extras,
    });
    nodes.set(id, node);
    return node;
  };

  const bindingsByTree = new Map<string, HistoryCommitBinding[]>();
  for (const binding of input.bindings) {
    const list = bindingsByTree.get(binding.treeHash) ?? [];
    list.push(binding);
    bindingsByTree.set(binding.treeHash, list);
  }

  for (const binding of input.bindings) {
    const node = ensureCommit(binding.commitSha, {
      treeHash: binding.treeHash,
      validationId: binding.validationId,
      runId: binding.runId,
      message: binding.message,
      refs: binding.refs,
      parents: binding.parents,
      createdAt: binding.createdAt,
      matchingCommitCount: (bindingsByTree.get(binding.treeHash) ?? []).length,
    });
    node.handoff = handoffForBranch(binding.refs[0], slots);
    for (const parent of binding.parents) {
      ensureCommit(parent);
      addEdge(commitNodeId(parent), commitNodeId(binding.commitSha), 'parent');
    }
  }

  for (const snapshot of input.snapshots) {
    const bound = bindingsByTree.get(snapshot.treeHash) ?? [];
    const legacySha = snapshot.commitSha && bound.every((row) => row.commitSha !== snapshot.commitSha)
      ? snapshot.commitSha
      : undefined;
    const commits = [
      ...bound.map((row) => row.commitSha),
      ...(legacySha ? [legacySha] : []),
    ];
    const slot = slotForBranch(snapshot.branch, slots);

    if (commits.length === 0) {
      const id = snapshotNodeId(snapshot.treeHash);
      nodes.set(
        id,
        emptyNode({
          id,
          kind: 'snapshot',
          pending: true,
          treeHash: snapshot.treeHash,
          headSha: snapshot.headSha,
          branch: snapshot.branch,
          agentId: snapshot.agentId ?? slot?.agentId,
          status: snapshot.status,
          full: snapshot.full,
          runId: snapshot.runId,
          changedFileCount: snapshot.changedFileCount,
          createdAt: snapshot.createdAt,
          validationId: snapshot.validationId,
          workUnitId: slot?.workUnitId ?? undefined,
          attemptId: slot?.attemptId ?? undefined,
          occupancyKey: snapshot.occupancyKey,
          handoff: handoffForBranch(snapshot.branch, slots),
        }),
      );
      if (snapshot.headSha) {
        ensureCommit(snapshot.headSha, { branch: snapshot.branch });
        addEdge(commitNodeId(snapshot.headSha), id, 'based-on');
      }
      continue;
    }

    for (const sha of commits) {
      const node = ensureCommit(sha, {
        treeHash: snapshot.treeHash,
        headSha: snapshot.headSha,
        branch: snapshot.branch ?? nodeBranch(nodes.get(commitNodeId(sha))),
        agentId: snapshot.agentId ?? slot?.agentId,
        status: snapshot.status,
        full: snapshot.full,
        runId: snapshot.runId,
        changedFileCount: snapshot.changedFileCount,
        createdAt: snapshot.createdAt,
        validationId: snapshot.validationId,
        workUnitId: slot?.workUnitId ?? undefined,
        attemptId: slot?.attemptId ?? undefined,
        occupancyKey: snapshot.occupancyKey,
        matchingCommitCount: commits.length,
        handoff: handoffForBranch(snapshot.branch, slots),
      });
      if (snapshot.headSha && snapshot.headSha !== sha) {
        ensureCommit(snapshot.headSha, { branch: snapshot.branch });
        addEdge(commitNodeId(snapshot.headSha), node.id, 'based-on');
      }
    }
  }

  // Base commits are plain commits on the base branch (usually main). They anchor the
  // graph but are not a worktree hand-off themselves, so their `handoff` stays unknown
  // unless a binding or snapshot on their own branch says otherwise.
  for (const slot of slots) {
    if (slot.baseCommit) ensureCommit(slot.baseCommit, { branch: slot.baseBranch ?? undefined });
  }

  return {
    nodes: [...nodes.values()].sort(compareNodes),
    edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

function nodeBranch(node: HistoryGraphNode | undefined): string | undefined {
  return node?.branch;
}

function compareNodes(a: HistoryGraphNode, b: HistoryGraphNode): number {
  const aTime = a.createdAt ?? '';
  const bTime = b.createdAt ?? '';
  if (aTime !== bTime) return aTime.localeCompare(bTime);
  return a.id.localeCompare(b.id);
}

export interface HistoryProvenance {
  commit: string | null;
  contentSnapshot: string | null;
  basedOn: string | null;
  verifiedByRun: string | null;
}

export function provenanceForNode(node: HistoryGraphNode): HistoryProvenance {
  return {
    commit: node.commitSha ?? null,
    contentSnapshot: node.treeHash ?? null,
    basedOn: node.headSha ?? null,
    verifiedByRun: node.runId ?? null,
  };
}

export const HANDOFF_LIFECYCLE_COPY =
  "HAR verifies the worktree's complete content snapshot. The pre-commit gate permits a commit only when its staged tree matches that snapshot. The post-commit hook then links the resulting commit to the validation. Handoff retains or publishes the worktree branch; it does not copy changes into a different branch automatically.";
