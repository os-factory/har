import { NextResponse } from 'next/server';
import { pageParams } from '@/server/pagination';
import { listVerificationRunsForRepo, verificationRunJson } from '@/server/verification-runs';

/** Verification runs received over OTLP, with their stages; paged on `since` / `sinceId` like the other repo reads. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const runs = await listVerificationRunsForRepo(id, pageParams(new URL(request.url)));
  return NextResponse.json({ verificationRuns: runs.map(verificationRunJson) });
}
