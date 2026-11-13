import { SyncValidationCommitBindingsInputSchema } from '@har/schemas';
import { prisma } from '@/lib/db';

function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as object;
}

export async function syncCommitBindings(repositoryId: string, input: unknown) {
  const { bindings } = SyncValidationCommitBindingsInputSchema.parse(input);
  for (const { parents, refs, createdAt, ...binding } of bindings) {
    const data = {
      ...binding,
      parents: toJson(parents),
      refs: toJson(refs),
      sourceCreatedAt: new Date(createdAt),
    };
    // Each worktree that validates a commit writes its own binding, so one
    // commit can arrive under several bindingIds; the last one synced wins.
    await prisma.validationCommitBinding.upsert({
      where: {
        repositoryId_treeHash_commitSha: {
          repositoryId,
          treeHash: binding.treeHash,
          commitSha: binding.commitSha,
        },
      },
      create: { repositoryId, ...data },
      update: data,
    });
  }
  return { synced: bindings.length };
}

export async function listCommitBindings(repositoryId: string) {
  return prisma.validationCommitBinding.findMany({
    where: { repositoryId },
    orderBy: { sourceCreatedAt: 'desc' },
  });
}
