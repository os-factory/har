import { prisma } from '@/lib/db';

export async function listCommitBindings(repositoryId: string) {
  return prisma.commitBinding.findMany({
    where: { repositoryId },
    orderBy: { committedAt: 'desc' },
  });
}
