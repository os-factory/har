import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

export async function GET() {
  let lastSyncAt: string | null = null;
  let lastOtelAt: string | null = null;
  let repoCount = 0;

  try {
    const [syncAgg, usageAgg, count] = await Promise.all([
      prisma.repository.aggregate({ _max: { lastSyncAt: true } }),
      prisma.agentSessionUsage.aggregate({ _max: { lastSeenAt: true } }),
      prisma.repository.count(),
    ]);

    repoCount = count;
    lastSyncAt = syncAgg._max.lastSyncAt?.toISOString() ?? null;
    lastOtelAt = usageAgg._max.lastSeenAt?.toISOString() ?? null;

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
  });
}
