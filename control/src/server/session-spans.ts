import type { AgentSessionSpan } from '@prisma/client';
import { prisma } from '@/lib/db';

const REPO_SPANS_LIMIT = 1_000;
const REPO_SPANS_MAX_LIMIT = 5_000;

export async function listSessionSpansForRepo(
  repositoryId: string,
  options: { since?: string | null; limit?: number } = {},
): Promise<AgentSessionSpan[]> {
  const limit = Math.max(1, Math.min(options.limit ?? REPO_SPANS_LIMIT, REPO_SPANS_MAX_LIMIT));
  const since = options.since ? new Date(options.since) : null;
  return prisma.agentSessionSpan.findMany({
    where: {
      repositoryId,
      ...(since && Number.isFinite(since.getTime()) ? { createdAt: { gt: since } } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
  });
}
