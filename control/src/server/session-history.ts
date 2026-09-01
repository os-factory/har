import {
  HANDOFF_LIFECYCLE_COPY,
  buildSessionHistoryGraph,
  provenanceForNode,
  type HistoryCommitBinding,
  type HistorySnapshot,
} from '@har/schemas';
import { prisma } from '@/lib/db';
import type { SessionHistoryExplanation, SessionHistoryView } from '@/lib/session-history-view';
import { listChangeBatches } from '@/server/change-batches';
import { listCommitBindings } from '@/server/commit-bindings';
import { getValidationStages } from '@/server/validation-stages';

export type { SessionHistoryExplanation, SessionHistoryView };

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function changedFilesOf(value: unknown): { path: string; status: string; oldPath?: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as { path?: unknown; status?: unknown; oldPath?: unknown };
    if (typeof row.path !== 'string' || typeof row.status !== 'string') return [];
    return [
      {
        path: row.path,
        status: row.status,
        ...(typeof row.oldPath === 'string' ? { oldPath: row.oldPath } : {}),
      },
    ];
  });
}

export async function getSessionHistory(repositoryId: string): Promise<SessionHistoryView | null> {
  const repo = await prisma.repository.findUnique({
    where: { id: repositoryId },
    include: { slots: true },
  });
  if (!repo) return null;

  const [batches, bindings, validation] = await Promise.all([
    listChangeBatches(repositoryId, 200),
    listCommitBindings(repositoryId),
    getValidationStages(repositoryId),
  ]);

  const snapshots: HistorySnapshot[] = batches.map((batch) => ({
    validationId: batch.validationId,
    treeHash: batch.treeHash,
    headSha: batch.headSha ?? undefined,
    branch: batch.branch ?? undefined,
    agentId: batch.agentId ?? undefined,
    status: batch.status === 'pass' ? 'pass' : 'fail',
    full: batch.full,
    runId: batch.runId ?? undefined,
    changedFileCount: changedFilesOf(batch.changedFiles).length,
    commitSha: batch.commitSha ?? undefined,
    createdAt: batch.createdAt.toISOString(),
  }));

  const historyBindings: HistoryCommitBinding[] = bindings.map((row) => ({
    bindingId: row.bindingId,
    validationId: row.validationId,
    treeHash: row.treeHash,
    commitSha: row.commitSha,
    parents: asStringArray(row.parents),
    refs: asStringArray(row.refs),
    message: row.message ?? undefined,
    runId: row.runId ?? undefined,
    createdAt: row.sourceCreatedAt.toISOString(),
  }));

  const graph = buildSessionHistoryGraph({
    snapshots,
    bindings: historyBindings,
    slots: repo.slots.map((slot) => ({
      agentId: slot.slotId,
      branch: slot.branch,
      baseBranch: slot.baseBranch,
      baseCommit: slot.baseCommit,
      active: slot.active,
      purpose: slot.purpose,
      attemptId: slot.attemptId,
      workUnitId: slot.workUnitId,
    })),
  });

  const batchesByTree = new Map(batches.map((batch) => [batch.treeHash, batch]));
  const agentIds = [
    ...new Set(
      graph.nodes
        .map((node) => node.agentId ?? (node.treeHash ? batchesByTree.get(node.treeHash)?.agentId : null))
        .filter((id): id is number => id != null),
    ),
  ];
  const trajectoryByAgent = new Map<number, { recordCount: number; firstPrompt: string | null }>();
  await Promise.all(
    agentIds.map(async (agentId) => {
      const [recordCount, prompt] = await Promise.all([
        prisma.agentTrajectoryRecord.count({ where: { repositoryId, agentId } }),
        prisma.agentTrajectoryRecord.findFirst({
          where: {
            repositoryId,
            agentId,
            eventType: { in: ['prompt.submitted', 'user', 'prompt'] },
          },
          orderBy: [{ sequence: 'asc' }, { eventTimestamp: 'asc' }],
        }),
      ]);
      let firstPrompt: string | null = null;
      const payload = prompt?.payload;
      if (payload && typeof payload === 'object' && payload !== null) {
        const text =
          (payload as { text?: unknown }).text ?? (payload as { prompt?: unknown }).prompt;
        if (typeof text === 'string' && text.trim()) firstPrompt = text.trim();
      }
      trajectoryByAgent.set(agentId, { recordCount, firstPrompt });
    }),
  );

  const explanations: Record<string, SessionHistoryExplanation> = {};

  for (const node of graph.nodes) {
    const batch = node.treeHash ? batchesByTree.get(node.treeHash) : undefined;
    const agentId = node.agentId ?? batch?.agentId ?? null;
    const trajectory = (agentId != null ? trajectoryByAgent.get(agentId) : undefined) ?? {
      recordCount: 0,
      firstPrompt: null,
    };

    explanations[node.id] = {
      node,
      provenance: provenanceForNode(node),
      stages: (validation?.stages ?? []).map((stage) => ({
        name: stage.name,
        lastStatus: stage.lastStatus,
        lastMs: stage.lastMs,
      })),
      changedFiles: changedFilesOf(batch?.changedFiles),
      trajectory: {
        agentId,
        recordCount: trajectory.recordCount,
        firstPrompt: trajectory.firstPrompt,
        slotHref: agentId != null ? `/repos/${repositoryId}/slots/${agentId}` : null,
      },
      reusedProof: node.matchingCommitCount > 1,
    };
  }

  return {
    graph,
    lifecycleCopy: HANDOFF_LIFECYCLE_COPY,
    explanations,
  };
}
