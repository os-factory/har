import { NextResponse } from 'next/server';
import {
  listRepositories,
  registerRepository,
  RepositoryUnregisteredError,
} from '@/server/repositories';

export async function GET() {
  const repos = await listRepositories();
  return NextResponse.json(
    repos.map((r) => ({
      id: r.id,
      path: r.path,
      gitRemote: r.gitRemote,
      lastSyncAt: r.lastSyncAt,
      runCount: r._count.runs,
      slotCount: r._count.slots,
      profile: (r.manifest as { profile?: string } | null)?.profile,
    })),
  );
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const repo = await registerRepository(body);
    return NextResponse.json({ id: repo.id, path: repo.path });
  } catch (err: unknown) {
    if (err instanceof RepositoryUnregisteredError) {
      return NextResponse.json({ error: err.message, path: err.path }, { status: 409 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
