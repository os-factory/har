import { SyncValidationCommitBindingsInputSchema } from '@har/schemas';
import { prisma } from '@/lib/db';

function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as object;
}

/** Commit bindings a 1.x `har control sync` sends, stored as v2 commit bindings (keyed by commit). */
export async function syncCommitBindings(repositoryId: string, input: unknown) {
  const { bindings } = SyncValidationCommitBindingsInputSchema.parse(input);
  for (const binding of bindings) {
    const run = await prisma.factoryRun.findUnique({
      where: { factoryRunId: binding.validationId },
      select: { branch: true, attestationDigest: true },
    });
    const data = {
      tree: binding.treeHash,
      factoryRunId: binding.validationId,
      parents: toJson(binding.parents),
      refs: toJson(binding.refs),
      message: binding.message ?? null,
      runId: binding.runId ?? null,
      committedAt: new Date(binding.createdAt),
      repositoryId,
    };
    // Each worktree writes its own binding for a commit; the last one synced wins.
    await prisma.commitBinding.upsert({
      where: { commitSha: binding.commitSha },
      create: {
        commitSha: binding.commitSha,
        branch: run?.branch ?? null,
        proofDigest: run?.attestationDigest ?? null,
        ...data,
      },
      update: data,
    });
  }
  return { synced: bindings.length };
}

export async function listCommitBindings(repositoryId: string) {
  return prisma.commitBinding.findMany({
    where: { repositoryId },
    orderBy: { committedAt: 'desc' },
  });
}
