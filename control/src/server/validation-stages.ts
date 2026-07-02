import {
  HarnessStageRegistrySchema,
  HarnessVerificationResultSchema,
  type HarnessVerificationResult,
} from '@har/schemas';
import { prisma } from '@/lib/db';

export interface ValidationStageStatus {
  name: string;
  declared: boolean;
  lastStatus: 'pass' | 'fail' | null;
  lastMs: number | null;
  lastOutput: string | null;
  lastRunId: string | null;
  lastAgentId: number | null;
  lastRunAt: Date | null;
  runCount: number;
  passCount: number;
}

export interface ValidationStagesSummary {
  stages: ValidationStageStatus[];
  latestRun: {
    runId: string;
    status: string;
    agentId: number | null;
    startedAt: Date;
  } | null;
  verifyRunCount: number;
}

/** Run.result for a verify run is a StageResult; the per-stage breakdown lives in
 *  data.verification, but older records may carry the raw verify.sh JSON at the top level. */
function extractVerification(result: unknown): HarnessVerificationResult | null {
  if (!result || typeof result !== 'object') return null;

  const data = (result as { data?: unknown }).data;
  if (data && typeof data === 'object') {
    const nested = HarnessVerificationResultSchema.safeParse(
      (data as { verification?: unknown }).verification,
    );
    if (nested.success) return nested.data;
  }

  const top = HarnessVerificationResultSchema.safeParse(result);
  return top.success ? top.data : null;
}

function emptyStage(name: string, declared: boolean): ValidationStageStatus {
  return {
    name,
    declared,
    lastStatus: null,
    lastMs: null,
    lastOutput: null,
    lastRunId: null,
    lastAgentId: null,
    lastRunAt: null,
    runCount: 0,
    passCount: 0,
  };
}

export async function getValidationStages(
  repositoryId: string,
): Promise<ValidationStagesSummary | null> {
  const repo = await prisma.repository.findUnique({ where: { id: repositoryId } });
  if (!repo) return null;

  const registry = HarnessStageRegistrySchema.safeParse(repo.stagesRegistry ?? {});
  const declared = registry.success
    ? (registry.data.verificationStages ??
      registry.data.stages.filter((s) => s.group === 'verification').map((s) => s.id))
    : [];

  const verifyRuns = await prisma.run.findMany({
    where: { repositoryId, stageId: 'verify' },
    orderBy: { startedAt: 'desc' },
    take: 50,
  });

  const byName = new Map<string, ValidationStageStatus>();
  for (const name of declared) byName.set(name, emptyStage(name, true));

  for (const run of verifyRuns) {
    const verification = extractVerification(run.result);
    if (!verification) continue;

    for (const step of verification.stages) {
      const entry = byName.get(step.name) ?? emptyStage(step.name, false);
      entry.runCount += 1;
      if (step.pass) entry.passCount += 1;
      // Runs are ordered newest-first, so the first sighting is the latest result.
      if (!entry.lastRunAt) {
        entry.lastStatus = step.pass ? 'pass' : 'fail';
        entry.lastMs = step.ms ?? null;
        entry.lastOutput = step.output ?? null;
        entry.lastRunId = run.runId;
        entry.lastAgentId = run.agentId;
        entry.lastRunAt = run.startedAt;
      }
      byName.set(step.name, entry);
    }
  }

  const undeclared = [...byName.values()]
    .filter((s) => !s.declared)
    .sort((a, b) => a.name.localeCompare(b.name));
  const stages = [...declared.map((name) => byName.get(name)!), ...undeclared];

  const latest = verifyRuns[0];
  return {
    stages,
    latestRun: latest
      ? {
          runId: latest.runId,
          status: latest.status,
          agentId: latest.agentId,
          startedAt: latest.startedAt,
        }
      : null,
    verifyRunCount: verifyRuns.length,
  };
}
