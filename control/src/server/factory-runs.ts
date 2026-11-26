import type { FactoryRun, StageResult } from '@prisma/client';
import { toFactoryProof, type FactoryProof } from '@/lib/factory-proof';
import { prisma } from '@/lib/db';

/** Stage results of these factory runs, in run order (`stageIds`), then by start time. */
export async function stagesOf(runs: Array<Pick<FactoryRun, 'factoryRunId' | 'stageIds'>>): Promise<Map<string, StageResult[]>> {
  const rows = runs.length
    ? await prisma.stageResult.findMany({
        where: { factoryRunId: { in: runs.map((run) => run.factoryRunId) } },
        orderBy: [{ startTime: 'asc' }, { stageId: 'asc' }],
      })
    : [];
  const out = new Map<string, StageResult[]>();
  for (const run of runs) {
    const order = Array.isArray(run.stageIds) ? (run.stageIds as string[]) : [];
    const stages = rows.filter((row) => row.factoryRunId === run.factoryRunId);
    const rank = (stageId: string) => {
      const index = order.indexOf(stageId);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };
    out.set(run.factoryRunId, [...stages].sort((a, b) => rank(a.stageId) - rank(b.stageId)));
  }
  return out;
}

/** Factory runs as the proofs a work unit page shows (verification traces received over OTLP or as records). */
export async function factoryProofsOf(
  runs: FactoryRun[],
  verifyRunIdByValidation: ReadonlyMap<string, string | null>,
  verifyRunIds: ReadonlySet<string> = new Set(),
): Promise<FactoryProof[]> {
  const stages = await stagesOf(runs);
  return runs.map((run) =>
    toFactoryProof(
      {
        runId: run.factoryRunId,
        traceId: run.traceId ?? '',
        pipelineName: run.pipelineName ?? 'verify',
        result: run.status ?? run.verdict ?? 'unknown',
        verdict: run.verdict,
        treeHash: run.tree || null,
        attestationDigest: run.attestationDigest,
        policyId: run.policyId,
        policyDigest: run.policyDigest,
        producerVersion: run.producerVersion,
        startTime: run.startedAt,
        stages: (stages.get(run.factoryRunId) ?? []).map((stage) => ({
          name: stage.stageId,
          result: stage.status,
          addedBy: stage.addedBy,
        })),
      },
      verifyRunIdByValidation,
      verifyRunIds,
    ),
  );
}
