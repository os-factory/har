import { NextResponse } from 'next/server';
import { MAIN_CHECKOUT_AGENT_ID, SyncUsageInputSchema } from '@har/schemas';
import { loadUsageView } from '@/server/session-attribution';
import { syncUsage } from '@/server/usage';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  // ADR 0003: slot usage is derived from observations and the binding timeline;
  // usage with no binding is per-session `unassigned` (main checkout), never a slot's.
  const view = await loadUsageView(id);
  return NextResponse.json({
    unassigned: view.unassigned,
    crossChecks: view.crossChecks,
    usage: view.rows.map((row) => ({
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
