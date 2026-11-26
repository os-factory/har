import fs from 'fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentTrajectoryRecordSchema } from '@har/schemas';

/**
 * Agent session spans as a real Claude Code + Codex run delivered them
 * (otel-hook 0.11, `run.sh --real-agents`), on a real SQLite database:
 *
 * - the lifecycle logs (`tool.start`, `tool.end`) carry their span's ids and
 *   arrive before the span; the span row is the span's, with its stamp;
 * - a resumed session reuses its session span id for a later span: both spans
 *   are kept;
 * - span times keep their milliseconds.
 */

const state = vi.hoisted(() => ({ dir: '' }));

vi.mock('@/lib/db', async () => {
  const path = await import('path');
  const { clientFor, pushSchema, tempDirectory } = await import('@/server/testing/sqlite-db');
  state.dir = tempDirectory('mc-trajectory-spans-');
  const file = path.join(state.dir, 'control.db');
  pushSchema(file);
  return { prisma: clientFor(file) };
});

import { prisma } from '@/lib/db';
import {
  canonicalizeOtelLogRecord,
  canonicalizeOtelSpan,
  extractLogRecords,
  extractSpans,
  type ParsedLogRecord,
  type ParsedSpan,
} from '@/server/otel-ingest';
import { appendTrajectoryRecord } from '@/server/trajectory-ledger';
import { stampedIds, withResourceStamps } from '@/server/stamped-ids';

const REPO = 'repo-1';
const TRACE = '1b73ce38c999f3a4de24e14fb860f19a';
const SESSION = 'c8df436e-853f-4fbe-8ee1-c5ee0eb1b73e';
const ATTEMPT = 'e64f85ad-b8dc-4f84-8900-34486bff9057';
const LAUNCH_SPAN = 'e92b1cb072efa4b3';
const SESSION_SPAN = '0b02075e74ed95c3';

const str = (key: string, value: string) => ({ key, value: { stringValue: value } });
const base = [str('session.id', SESSION), str('otelhook.provider.id', 'claude-code')];
const stamp = [str('factory.work_unit.id', 'e2e-1'), str('factory.attempt.id', ATTEMPT)];

function spans(...list: Array<{ spanId: string; name: string; start: string; end: string; attributes: unknown[] }>) {
  return {
    resourceSpans: [{
      resource: { attributes: [str('service.name', 'har-ide-agent')] },
      scopeSpans: [{
        scope: { name: '@osfactory/otel-hook' },
        spans: list.map((span) => ({
          traceId: TRACE,
          spanId: span.spanId,
          name: span.name,
          startTimeUnixNano: span.start,
          endTimeUnixNano: span.end,
          attributes: span.attributes,
        })),
      }],
    }],
  };
}

function log(spanId: string, type: string, at: string, attributes: unknown[]) {
  return {
    resourceLogs: [{
      resource: { attributes: [str('service.name', 'har-ide-agent')] },
      scopeLogs: [{
        scope: { name: '@osfactory/otel-hook' },
        logRecords: [{
          timeUnixNano: at,
          traceId: TRACE,
          spanId,
          body: {},
          attributes: [...attributes, str('otelhook.event.type', type), str('otelhook.event.id', `evt_${type}_${at}`)],
        }],
      }],
    }],
  };
}

/** What `ingestOtelLogsJson` appends once it placed the record in slot 1. */
async function appendLog(record: ParsedLogRecord) {
  const canonical = canonicalizeOtelLogRecord({ ...record, attributes: withResourceStamps(record.resource, record.attributes) });
  const stamps = stampedIds(record.attributes, record.resource);
  return appendTrajectoryRecord(REPO, AgentTrajectoryRecordSchema.parse({
    version: 1, source: 'otel', sourceEventId: canonical.sourceEventId, contentKey: canonical.contentKey,
    sessionKey: SESSION, agentId: 1, agentTool: 'claude_code', eventType: canonical.eventType,
    sequence: canonical.sequence, timestamp: record.timestamp.toISOString(), payload: canonical.payload,
    contentKind: canonical.contentKind, contentDisclosure: canonical.contentDisclosure,
    traceId: record.traceId, spanId: record.spanId, workUnitId: stamps.workUnitId ?? undefined,
    attemptId: stamps.attemptId ?? undefined,
  }));
}

/** What `ingestOtelTracesJson` appends once it placed the span in slot 1. */
async function appendSpan(span: ParsedSpan) {
  const canonical = canonicalizeOtelSpan({ ...span, attributes: withResourceStamps(span.resource, span.attributes) });
  const stamps = stampedIds(span.attributes, span.resource);
  return appendTrajectoryRecord(REPO, AgentTrajectoryRecordSchema.parse({
    version: 1, source: 'otel', sourceEventId: canonical.sourceEventId, contentKey: canonical.contentKey,
    sessionKey: SESSION, agentId: 1, agentTool: 'claude_code', eventType: canonical.eventType,
    sequence: canonical.sequence, timestamp: span.startTime.toISOString(), payload: canonical.payload,
    contentKind: canonical.contentKind, contentDisclosure: canonical.contentDisclosure,
    traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId ?? undefined,
    workUnitId: stamps.workUnitId ?? undefined, attemptId: stamps.attemptId ?? undefined,
  }));
}

beforeAll(async () => {
  await prisma.repository.create({ data: { id: REPO, path: '/repo' } });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(state.dir, { recursive: true, force: true });
});

describe('agent session spans from otel-hook', () => {
  it('stores the launch tool span with its own stamp, though its unstamped tool.start log came first', async () => {
    // The tool call that runs `har env launch`: tool.start before the attempt
    // existed (no stamp), tool.end and the span inside it (stamped).
    const [start] = extractLogRecords(log(LAUNCH_SPAN, 'tool.start', '1795691568771000000', base));
    const [end] = extractLogRecords(log(LAUNCH_SPAN, 'tool.end', '1795691572748000000', [...base, ...stamp]));
    await appendLog(start);
    await appendLog(end);
    const [span] = extractSpans(spans({
      spanId: LAUNCH_SPAN, name: 'tool Bash', start: '1795691568771000000', end: '1795691572748000000',
      attributes: [...base, ...stamp, str('gen_ai.tool.name', 'Bash')],
    }));
    await appendSpan(span);

    const rows = await prisma.agentSessionSpan.findMany({ where: { spanId: LAUNCH_SPAN } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'tool Bash', attemptId: ATTEMPT, workUnitId: 'e2e-1', sessionId: SESSION });
    expect(rows[0].startTime.toISOString()).toBe('2026-11-26T11:12:48.771Z');
    expect(rows[0].endTime?.toISOString()).toBe('2026-11-26T11:12:52.748Z');
  });

  it('keeps the milliseconds of a nanosecond timestamp', () => {
    const [span] = extractSpans(spans({
      spanId: 'b0b1ec96580a9080', name: 'prompt', start: '1795691566618000000', end: '1795691582570000000', attributes: base,
    }));
    expect(span.startTime.toISOString()).toBe('2026-11-26T11:12:46.618Z');
    expect(span.endTime?.toISOString()).toBe('2026-11-26T11:13:02.570Z');
  });

  it('keeps both spans of a resumed session that reuses the span id, each with its own identity', async () => {
    const [first] = extractSpans(spans({
      spanId: SESSION_SPAN, name: 'session', start: '1795691564598000000', end: '1795691585069000000', attributes: [...base, ...stamp],
    }));
    const [resumed] = extractSpans(spans({
      spanId: SESSION_SPAN, name: 'session', start: '1795691622638000000', end: '1795691633451000000', attributes: base,
    }));
    expect((await appendSpan(first)).inserted).toBe(true);
    expect((await appendSpan(resumed)).inserted).toBe(true);
    // A re-delivery of either is still deduplicated.
    expect((await appendSpan(first)).inserted).toBe(false);
    expect((await appendSpan(resumed)).inserted).toBe(false);

    const rows = await prisma.agentSessionSpan.findMany({ where: { spanId: SESSION_SPAN }, orderBy: { startTime: 'asc' } });
    expect(rows.map((row) => [row.startTime.toISOString(), row.attemptId])).toEqual([
      ['2026-11-26T11:12:44.598Z', ATTEMPT],
      ['2026-11-26T11:13:42.638Z', null],
    ]);
    const records = await prisma.agentTrajectoryRecord.findMany({ where: { spanId: SESSION_SPAN, eventType: 'span.session' } });
    expect(records.map((record) => record.sourceEventId).sort()).toEqual([
      `span:${TRACE}:${SESSION_SPAN}`,
      `span:${TRACE}:${SESSION_SPAN}@2026-11-26T11:13:42.638Z`,
    ]);
  });

  it('refreshes the identity columns when the same span is delivered again as a 1.x mirror', async () => {
    // A 1.x `span.*` mirror log of a span already stored: same (trace, span, start).
    const spanId = 'c63ae4ce2a2c9adb';
    const [span] = extractSpans(spans({
      spanId, name: 'tool Bash', start: '1795691574728000000', end: '1795691575045000000', attributes: base,
    }));
    await appendSpan(span);
    const [mirror] = extractLogRecords(log(spanId, 'span.tool Bash', '1795691574728000000', [...base, ...stamp]));
    await appendLog({ ...mirror, eventName: 'span.tool Bash' });
    const rows = await prisma.agentSessionSpan.findMany({ where: { spanId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ attemptId: ATTEMPT, workUnitId: 'e2e-1' });
    expect(rows[0].endTime?.toISOString()).toBe('2026-11-26T11:12:55.045Z');
  });
});
