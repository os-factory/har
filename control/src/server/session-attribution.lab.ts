import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db';
import { ingestOtelLogsJson, ingestOtelTracesJson } from '@/server/otel-ingest';
import { loadUsageView, syncSessionBindings, syncUsageObservations } from '@/server/session-attribution';

/**
 * Session attribution lab (ADR 0003) — the whole path against a REAL SQLite
 * database: bindings and observations through the sync entry points and OTLP
 * ingest, then the derived usage view. Nothing is mocked.
 *
 * Excluded from `npm test`. Run against a scratch database:
 *   DATABASE_URL=file:/tmp/x.db npx prisma db push --skip-generate
 *   DATABASE_URL=file:/tmp/x.db npx vitest run --config vitest.lab.config.ts src/server/session-attribution.lab.ts
 */

const MAIN = `/lab/session-attribution-${Date.now()}`;
const SLOT_2 = `${MAIN}-worktrees/agent-2`;
const SLOT_3 = `${MAIN}-worktrees/agent-3`;
const SID = '11111111-2222-4333-8444-555555555555';
const T0 = Date.parse('2026-11-12T10:00:00.000Z');
const iso = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const nanos = (minutes: number) => `${BigInt(T0 + minutes * 60_000) * 1_000_000n}`;

let repositoryId = '';

function attrs(map: Record<string, string | number>) {
  return Object.entries(map).map(([key, value]) => ({
    key,
    value: typeof value === 'number' ? { intValue: value } : { stringValue: value },
  }));
}

function apiRequest(minutes: number, requestId: string, cost: number, extra: Record<string, string | number> = {}) {
  return {
    timeUnixNano: nanos(minutes),
    body: { stringValue: 'claude_code.api_request' },
    attributes: attrs({
      'event.name': 'api_request',
      'event.timestamp': iso(minutes),
      'session.id': SID,
      request_id: requestId,
      model: 'claude-opus-5-5',
      input_tokens: 10,
      output_tokens: 20,
      cost_usd: cost,
      ...extra,
    }),
  };
}

beforeAll(async () => {
  const repo = await prisma.repository.create({ data: { path: MAIN } });
  repositoryId = repo.id;
  for (const [slotId, workDir] of [[2, SLOT_2], [3, SLOT_3]] as const) {
    await prisma.agentSlot.create({
      data: {
        repositoryId,
        slotId,
        active: true,
        workDir,
        worktreePath: workDir,
        branch: `lab-agent-${slotId}`,
        occupancyKey: `occ-${slotId}`,
        sessionCreatedAt: new Date(T0),
      },
    });
  }
});

afterAll(async () => {
  if (repositoryId) await prisma.repository.delete({ where: { id: repositoryId } });
  await prisma.$disconnect();
});

describe('session attribution on a real database', () => {
  it('splits one Claude session between main, slot 2 and slot 3, and re-attributes on a late binding', async () => {
    // A hook span in the main checkout makes the session's repository known.
    await ingestOtelTracesJson({
      resourceSpans: [
        {
          resource: { attributes: attrs({ 'otelhook.provider.id': 'claude-code' }) },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: 'a'.repeat(32),
                  spanId: '1'.repeat(16),
                  name: 'prompt',
                  startTimeUnixNano: nanos(0),
                  endTimeUnixNano: nanos(0),
                  attributes: attrs({ 'gen_ai.client.workspace': MAIN, 'otelhook.session.id': SID }),
                },
                {
                  // Edits a file in slot 3's worktree at minute 20: observed binding.
                  traceId: 'a'.repeat(32),
                  spanId: '2'.repeat(16),
                  name: 'tool Edit',
                  startTimeUnixNano: nanos(20),
                  endTimeUnixNano: nanos(20),
                  attributes: attrs({
                    'gen_ai.client.workspace': MAIN,
                    'otelhook.session.id': SID,
                    'vcs.ref.head.name': 'lab-agent-3',
                    'otelhook.target.source': 'tool-path',
                  }),
                },
              ],
            },
          ],
        },
      ],
    });

    const logs = await ingestOtelLogsJson({
      resourceLogs: [
        {
          resource: { attributes: attrs({ 'service.name': 'claude-code' }) },
          scopeLogs: [
            {
              logRecords: [
                apiRequest(5, 'req_a', 1),
                apiRequest(15, 'req_b', 2),
                apiRequest(25, 'req_c', 4),
                apiRequest(26, 'req_d', 8, { agent_id: 'sub-1' }),
              ],
            },
          ],
        },
      ],
    });
    expect(logs).toMatchObject({ accepted: 4, dropped: 0 });

    // Harvested copy of req_b without a cost: merges, never erases the cost.
    await syncUsageObservations(repositoryId, {
      observations: [
        { agentTool: 'claude_code', sessionId: SID, observationKey: 'req_b', observedAt: iso(15), granularity: 'message', source: 'harvest', tokensInput: 10, tokensOutput: 20 },
      ],
    });

    let view = await loadUsageView(repositoryId);
    const bySlot = () =>
      Object.fromEntries(
        [
          ...view.rows.filter((row) => row.origin === 'observations').map((row) => [`slot-${row.agentId}`, Number(row.costUsd)]),
          ...view.unassigned.map((row) => ['main', row.costUsd]),
        ],
      );
    expect(bySlot()).toEqual({ main: 3, 'slot-3': 12 });

    // The launch of slot 2 at minute 10 is synced late: it re-attributes req_b.
    await syncSessionBindings(repositoryId, {
      bindings: [{ agentTool: 'claude_code', sessionId: SID, kind: 'launch', slotId: 2, branch: 'lab-agent-2', at: iso(10) }],
    });
    view = await loadUsageView(repositoryId);
    expect(bySlot()).toEqual({ main: 1, 'slot-2': 2, 'slot-3': 12 });
    expect(view.rows.find((row) => row.agentId === 2)).toMatchObject({ occupancyKey: 'occ-2', sessionKey: SID });

    const stored = await prisma.sessionSlotBinding.findMany({ where: { repositoryId }, orderBy: { at: 'asc' } });
    expect(stored.map((row) => `${row.kind}:${row.slotId}:${row.occupancyKey}`)).toEqual(['launch:2:occ-2', 'observed:3:occ-3']);
  });

  it('stores Codex hook turns as per-turn usage that merges with the harvest by turn id', async () => {
    const turn = (minutes: number, turnId: string, input: number) => ({
      traceId: 'b'.repeat(32),
      spanId: `${minutes}`.padStart(16, '0'),
      name: 'generation gpt-5.5-codex',
      startTimeUnixNano: nanos(minutes),
      endTimeUnixNano: nanos(minutes),
      attributes: attrs({
        'gen_ai.client.workspace': SLOT_2,
        'otelhook.session.id': 'thread-lab',
        'otelhook.generation.id': turnId,
        'otelhook.usage.temporality': 'cumulative',
        'gen_ai.usage.input_tokens': input,
        'gen_ai.usage.output_tokens': 0,
      }),
    });
    await syncUsageObservations(repositoryId, {
      observations: [
        { agentTool: 'codex', sessionId: 'thread-lab', observationKey: 'turn-1', observedAt: iso(31), granularity: 'turn', source: 'harvest', tokensInput: 100 },
      ],
    });
    await ingestOtelTracesJson({
      resourceSpans: [
        {
          resource: { attributes: attrs({ 'otelhook.provider.id': 'codex' }) },
          scopeSpans: [{ spans: [turn(33, 'turn-3', 600), turn(32, 'turn-2', 250)] }],
        },
      ],
    });
    const rows = await prisma.usageObservation.findMany({
      where: { repositoryId, sessionId: 'thread-lab' },
      orderBy: { observedAt: 'asc' },
    });
    expect(rows.map((row) => [row.observationKey, Number(row.tokensInput)])).toEqual([
      ['turn-1', 100],
      ['turn-2', 150],
      ['turn-3', 350],
    ]);
    // Turn 1 predates the session's first evidence of slot 2 (its cwd, from turn 2 on).
    const view = await loadUsageView(repositoryId);
    expect(view.rows.find((row) => row.agentTool === 'codex')).toMatchObject({ agentId: 2, tokensInput: 500n });
    expect(view.unassigned.find((row) => row.agentTool === 'codex')).toMatchObject({ tokensInput: 100 });
  });
});
