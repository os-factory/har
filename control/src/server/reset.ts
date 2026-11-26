import {
  ResetMissionControlInputSchema,
  type ResetMissionControlResult,
} from '@har/schemas';
import { prisma } from '@/lib/db';
import { scrubLocalHarnessForRepos } from './harness-scrub';

/**
 * Wipe all Mission Control dashboard data and optionally scrub local `.har`
 * history dirs so a later register/sync does not re-pollute the UI.
 */
export async function resetMissionControl(input: unknown): Promise<ResetMissionControlResult> {
  const options = ResetMissionControlInputSchema.parse(input);

  const repos = await prisma.repository.findMany({
    select: { path: true },
    orderBy: { path: 'asc' },
  });
  const repoPaths = repos.map((repo) => repo.path);

  let scrubbed: ResetMissionControlResult['scrubbed'] = [];
  if (options.scrubLocalHarness) {
    scrubbed = scrubLocalHarnessForRepos(repoPaths);
  }

  const deletedRepos = await prisma.repository.deleteMany();
  // Ingest v2 records need no registered repository (ADR 0005), so a cascade misses some.
  await prisma.$transaction([
    prisma.stageResult.deleteMany(),
    prisma.factoryRun.deleteMany(),
    prisma.commitBinding.deleteMany(),
    prisma.attestation.deleteMany(),
    prisma.sessionSegment.deleteMany(),
    prisma.attempt.deleteMany(),
    prisma.workUnit.deleteMany(),
    prisma.evidenceBlob.deleteMany(),
    prisma.metricSeries.deleteMany(),
  ]);
  const clearedUnregistered = await prisma.unregisteredRepository.deleteMany();

  return {
    ok: true,
    repositoriesDeleted: deletedRepos.count,
    unregisteredCleared: clearedUnregistered.count,
    scrubLocalHarness: options.scrubLocalHarness,
    scrubbed,
    repoPaths,
  };
}
