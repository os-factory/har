import { NextResponse } from 'next/server';
import { checkMissionControlUsage, UnknownRepositoryError } from '@/server/usage-invariants';

/**
 * Usage invariants (FE-2058): `GET /api/usage/invariants[?repo=<id|path>]`.
 * Read-only. `har control check-usage` prints it; `har control sync` leaves
 * its `blockedUnits` out of the HQ post.
 */
export async function GET(request: Request) {
  const repo = new URL(request.url).searchParams.get('repo');
  try {
    return NextResponse.json(await checkMissionControlUsage(repo));
  } catch (err: unknown) {
    if (err instanceof UnknownRepositoryError) return NextResponse.json({ error: err.message }, { status: 404 });
    throw err;
  }
}
