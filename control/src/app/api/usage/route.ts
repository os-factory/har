import { NextResponse } from 'next/server';
import { listAllUsage, summarizeUsageRows } from '@/server/usage';

export async function GET() {
  const { rows, unassigned } = await listAllUsage();
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
    // ADR 0003: usage with no slot binding in force, per session (main checkout).
    unassigned: unassigned.map(({ repository, ...row }) => ({
      ...row,
      repoPath: repository.path,
      firstSeenAt: row.firstSeenAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
    })),
  });
}
