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
import { occupancyKeyForAttempt } from '@/server/occupancy';
import { extractVerification } from '@/server/validation-stages';
import type { SessionHistoryStageBadge } from '@/lib/session-history-view';

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

  const [batches, bindings, validationBindings] = await Promise.all([
    listChangeBatches(repositoryId, 200),
    listCommitBindings(repositoryId),
    prisma.validationBinding.findMany({
      where: { repositoryId },
      select: { validationId: true, attempt: { select: { attemptId: true } } },
    }),
  ]);
  // A validation binding ties the snapshot to the attempt exactly; the stamped key is
  // the fallback for snapshots produced without --work-id (#348).
  const attemptByValidation = new Map(validationBindings.map((row) => [row.validationId, row.attempt.attemptId]));

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
    occupancyKey: (() => {
      const attemptId = attemptByValidation.get(batch.validationId);
      return attemptId ? occupancyKeyForAttempt(attemptId) : batch.occupancyKey ?? undefined;
    })(),
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

  // Stage badges come from the run that verified this exact tree — never from the
  // repository's latest run, which may belong to another slot or branch.
  const runIds = [...new Set(graph.nodes.map((node) => node.runId).filter((id): id is string => Boolean(id)))];
  const runs = runIds.length
    ? await prisma.run.findMany({ where: { repositoryId, runId: { in: runIds } }, select: { runId: true, result: true } })
    : [];
  const stagesByRun = new Map<string, SessionHistoryStageBadge[]>();
  for (const run of runs) {
    const verification = extractVerification(run.result);
    if (!verification) continue;
    stagesByRun.set(
      run.runId,
      verification.stages.map((stage) => ({
        name: stage.name,
        lastStatus: stage.pass ? 'pass' : 'fail',
        lastMs: typeof stage.ms === 'number' ? stage.ms : null,
      })),
    );
  }

  const explanations: Record<string, SessionHistoryExplanation> = {};

  for (const node of graph.nodes) {
    const batch = node.treeHash ? batchesByTree.get(node.treeHash) : undefined;
    explanations[node.id] = {
      node,
      provenance: provenanceForNode(node),
      stages: (node.runId ? stagesByRun.get(node.runId) : undefined) ?? [],
      changedFiles: changedFilesOf(batch?.changedFiles),
      reusedProof: node.matchingCommitCount > 1,
    };
  }

  return {
    graph,
    lifecycleCopy: HANDOFF_LIFECYCLE_COPY,
    explanations,
  };
}
