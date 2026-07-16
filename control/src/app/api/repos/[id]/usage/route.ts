import { NextResponse } from 'next/server';
import { SyncUsageInputSchema } from '@har/schemas';
import { listSessionUsageForRepo, syncUsage } from '@/server/usage';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const usage = await listSessionUsageForRepo(id);
  return NextResponse.json({
    usage: usage.map((row) => ({
      ...row,
      tokensInput: Number(row.tokensInput),
      tokensOutput: Number(row.tokensOutput),
      tokensCacheRead: Number(row.tokensCacheRead),
      tokensCacheCreation: Number(row.tokensCacheCreation),
      tokensTotal: Number(row.tokensTotal),
      costUsd: row.costUsd == null ? null : Number(row.costUsd),
    })),
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const parsed = SyncUsageInputSchema.parse(body);
    const result = await syncUsage(id, parsed.usage);
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
