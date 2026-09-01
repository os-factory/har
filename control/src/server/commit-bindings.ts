import { SyncValidationCommitBindingsInputSchema } from '@har/schemas';
import { prisma } from '@/lib/db';

function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as object;
}

export async function syncCommitBindings(repositoryId: string, input: unknown) {
  const { bindings } = SyncValidationCommitBindingsInputSchema.parse(input);
  for (const binding of bindings) {
    const data = {
      validationId: binding.validationId,
      treeHash: binding.treeHash,
      commitSha: binding.commitSha,
      parents: toJson(binding.parents),
      refs: toJson(binding.refs),
      message: binding.message,
      runId: binding.runId,
      sourceCreatedAt: new Date(binding.createdAt),
    };
    await prisma.validationCommitBinding.upsert({
      where: { repositoryId_bindingId: { repositoryId, bindingId: binding.bindingId } },
      create: {
        repositoryId,
        bindingId: binding.bindingId,
        ...data,
      },
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
