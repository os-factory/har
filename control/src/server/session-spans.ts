import type { AgentSessionSpan } from '@prisma/client';
import { prisma } from '@/lib/db';
import { clampPageLimit, createdAtKeyset } from '@/server/pagination';

const REPO_SPANS_LIMIT = 1_000;
const REPO_SPANS_MAX_LIMIT = 5_000;

export async function listSessionSpansForRepo(
  repositoryId: string,
  options: { since?: string | null; sinceId?: string | null; limit?: number } = {},
): Promise<AgentSessionSpan[]> {
  return prisma.agentSessionSpan.findMany({
    where: { repositoryId, ...createdAtKeyset(options) },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: clampPageLimit(options.limit, REPO_SPANS_LIMIT, REPO_SPANS_MAX_LIMIT),
  });
}
