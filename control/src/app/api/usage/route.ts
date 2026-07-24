import { NextResponse } from 'next/server';
import { listAllSessionUsage, summarizeUsageRows } from '@/server/usage';

export async function GET() {
  const rows = await listAllSessionUsage();
  const summary = summarizeUsageRows(rows);
  return NextResponse.json({
    summary: {
      ...summary,
      lastSeenAt: summary.lastSeenAt?.toISOString() ?? null,
    },
    usage: rows.map((row) => ({
      id: row.id,
      repositoryId: row.repositoryId,
      repoPath: row.repository.path,
      sessionKey: row.sessionKey,
      agentId: row.agentId,
      agentTool: row.agentTool,
      workUnitId: row.workUnitId,
      attemptId: row.attemptId,
      tokensTotal: Number(row.tokensTotal),
      costUsd: row.costUsd == null ? null : Number(row.costUsd),
      sources: row.sources,
      lastSeenAt: row.lastSeenAt.toISOString(),
    })),
  });
}
