import { NextResponse } from 'next/server';
import { MAIN_CHECKOUT_AGENT_ID, SyncUsageInputSchema } from '@har/schemas';
import { syncUsage } from '@/server/usage';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const body = await request.json();
    // A session total harvested for a session whose spans sit in the main
    // checkout (agentId 0, ADR 0003) is not a slot's usage: skip it rather than
    // reject the batch. Its usage arrives as observations instead.
    const rows: unknown[] = Array.isArray(body?.usage) ? body.usage : [];
    const mainCheckout = rows.filter(
      (row) => (row as { agentId?: unknown } | null)?.agentId === MAIN_CHECKOUT_AGENT_ID,
    );
    const parsed = SyncUsageInputSchema.parse(
      mainCheckout.length ? { ...body, usage: rows.filter((row) => !mainCheckout.includes(row)) } : body,
    );
    const result = await syncUsage(id, parsed.usage);
    return NextResponse.json({ ...result, skipped: mainCheckout.length });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
