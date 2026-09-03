import {
  HarnessStageRegistrySchema,
  HarnessVerificationStepSchema,
  type HarnessStage,
  type HarnessVerificationResult,
} from '@har/schemas';
import { z } from 'zod';
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

/** A verify run stores its per-stage breakdown in `result.data.verification`; older records
 *  carry the raw verify.sh JSON at the top level or only in the stdout log. Some producers name
 *  the array `steps` instead of `stages`. Normalise all of them to `{ stages }`. */
const LooseVerificationSchema = z
  .object({
    stages: z.array(HarnessVerificationStepSchema).optional(),
    steps: z.array(HarnessVerificationStepSchema).optional(),
  })
  .passthrough();

type VerificationSteps = Pick<HarnessVerificationResult, 'stages'>;

function normalizeVerification(candidate: unknown): VerificationSteps | null {
  const parsed = LooseVerificationSchema.safeParse(candidate);
  if (!parsed.success) return null;
  const stages = parsed.data.stages ?? parsed.data.steps;
  return stages && stages.length > 0 ? { stages } : null;
}

function verificationFromLogs(result: { logs?: unknown }): VerificationSteps | null {
  if (!Array.isArray(result.logs)) return null;
  for (const log of result.logs) {
    const content = (log as { content?: unknown }).content;
    if (typeof content !== 'string' || !content.trimStart().startsWith('{')) continue;
    try {
      const found = normalizeVerification(JSON.parse(content));
      if (found) return found;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

export function extractVerification(result: unknown): VerificationSteps | null {
  if (!result || typeof result !== 'object') return null;

  const data = (result as { data?: unknown }).data;
  if (data && typeof data === 'object') {
    const nested = normalizeVerification((data as { verification?: unknown }).verification);
    if (nested) return nested;
  }

  return normalizeVerification(result) ?? verificationFromLogs(result as { logs?: unknown });
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

export interface ValidationStagesScope {
  agentId?: number;
  /** Occupancy start: runs before it belong to an earlier occupant of the same slot number. */
  since?: Date | null;
  /** Occupancy work dir: runs from another worktree are another occupant. */
  workDir?: string | null;
  /** Exact set of runs (an attempt record, #348); other filters still apply. */
  runIds?: string[];
}

export async function getValidationStages(
  repositoryId: string,
  options?: ValidationStagesScope,
): Promise<ValidationStagesSummary | null> {
  const repo = await prisma.repository.findUnique({ where: { id: repositoryId } });
  if (!repo) return null;

  const registry = HarnessStageRegistrySchema.safeParse(repo.stagesRegistry ?? {});
  const declared = registry.success
    ? (registry.data.verificationStages ??
      registry.data.stages
        .filter((s: HarnessStage) => s.group === 'verification')
        .map((s: HarnessStage) => s.id))
    : [];

  const verifyRuns = await prisma.run.findMany({
    where: {
      repositoryId,
      stageId: 'verify',
      ...(options?.agentId != null ? { agentId: options.agentId } : {}),
      ...(options?.since ? { startedAt: { gte: options.since } } : {}),
      ...(options?.workDir ? { workDir: options.workDir } : {}),
      ...(options?.runIds ? { runId: { in: options.runIds } } : {}),
    },
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
  const stages = [...declared.map((name: string) => byName.get(name)!), ...undeclared];

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
