import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/** Activity within this window counts as MCP "recent" (working). */
const MCP_RECENT_MS = 60 * 60 * 1000;

type McpActivityStatus = 'recent' | 'stale' | 'none';

function mcpStatusFromLastAt(lastActivityAt: Date | null): McpActivityStatus {
  if (!lastActivityAt) return 'none';
  return Date.now() - lastActivityAt.getTime() <= MCP_RECENT_MS ? 'recent' : 'stale';
}

export async function GET() {
  let lastSyncAt: string | null = null;
  let lastOtelAt: string | null = null;
  let repoCount = 0;
  let mcp: {
    probeable: false;
    status: McpActivityStatus;
    lastActivityAt: string | null;
    source: 'run' | 'slot' | null;
    recentWindowMinutes: number;
  } = {
    probeable: false,
    status: 'none',
    lastActivityAt: null,
    source: null,
    recentWindowMinutes: MCP_RECENT_MS / 60_000,
  };

  try {
    const [syncAgg, usageAgg, count, latestMcpRun, latestMcpSlot] = await Promise.all([
      prisma.repository.aggregate({ _max: { lastSyncAt: true } }),
      prisma.agentSessionUsage.aggregate({ _max: { lastSeenAt: true } }),
      prisma.repository.count(),
      prisma.run.findFirst({
        where: { trigger: 'mcp' },
        orderBy: { startedAt: 'desc' },
        select: { startedAt: true },
      }),
      prisma.agentSlot.findFirst({
        where: { harnessUsage: 'mcp' },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      }),
    ]);

    repoCount = count;
    lastSyncAt = syncAgg._max.lastSyncAt?.toISOString() ?? null;
    lastOtelAt = usageAgg._max.lastSeenAt?.toISOString() ?? null;

    const runAt = latestMcpRun?.startedAt ?? null;
    const slotAt = latestMcpSlot?.updatedAt ?? null;
    let lastActivityAt: Date | null = null;
    let source: 'run' | 'slot' | null = null;
    if (runAt && slotAt) {
      if (runAt.getTime() >= slotAt.getTime()) {
        lastActivityAt = runAt;
        source = 'run';
      } else {
        lastActivityAt = slotAt;
        source = 'slot';
      }
    } else if (runAt) {
      lastActivityAt = runAt;
      source = 'run';
    } else if (slotAt) {
      lastActivityAt = slotAt;
      source = 'slot';
    }

    mcp = {
      probeable: false,
      status: mcpStatusFromLastAt(lastActivityAt),
      lastActivityAt: lastActivityAt?.toISOString() ?? null,
      source,
      recentWindowMinutes: MCP_RECENT_MS / 60_000,
    };

    try {
      const eventAgg = await prisma.agentSessionEvent.aggregate({ _max: { timestamp: true } });
      const eventTs = eventAgg._max.timestamp?.getTime() ?? 0;
      const usageTs = usageAgg._max.lastSeenAt?.getTime() ?? 0;
      if (eventTs > usageTs) {
        lastOtelAt = new Date(eventTs).toISOString();
      }
    } catch {
      // Schema may lag briefly after deploy.
    }
  } catch {
    // Keep ok:true for harness probes even if DB is mid-migrate.
  }

  return NextResponse.json({
    ok: true,
    service: 'har-control',
    repoCount,
    lastSyncAt,
    lastOtelAt,
    otelReady: true,
    mcp,
  });
}
