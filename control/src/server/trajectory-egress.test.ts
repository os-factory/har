import { beforeEach, describe, expect, it, vi } from 'vitest';

const trajectoryFindMany = vi.fn();
const spanFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    agentTrajectoryRecord: {
      findMany: (...args: unknown[]) => trajectoryFindMany(...args),
    },
    agentSessionSpan: {
      findMany: (...args: unknown[]) => spanFindMany(...args),
    },
  },
}));

import { listTrajectoryForRepo, serializeTrajectoryForEgress } from './trajectory-ledger';
import { listSessionSpansForRepo } from './session-spans';

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    repositoryId: 'repo-1',
    version: 1,
    source: 'otel',
    sourceEventId: 'evt-1',
    contentKey: 'prompt',
    sessionKey: 'feat/x',
    agentId: 1,
    agentTool: 'claude_code',
    eventType: 'claude_code.user_prompt',
    sequence: 3,
    eventTimestamp: new Date('2026-01-01T00:00:00.000Z'),
    payload: { promptText: 'hello', attributes: {} },
    contentKind: 'prompt',
    contentDisclosure: 'full',
    contentLabel: null,
    traceId: null,
    spanId: null,
    parentSpanId: null,
    generationId: null,
    toolCallId: null,
    correlationId: null,
    workUnitId: null,
    attemptId: null,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('listTrajectoryForRepo', () => {
  beforeEach(() => trajectoryFindMany.mockReset());

  it('reads in storage order so a late fact is not stranded behind the watermark', async () => {
    trajectoryFindMany.mockResolvedValue([]);
    await listTrajectoryForRepo('repo-1');
    expect(trajectoryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { repositoryId: 'repo-1' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  });

  it('filters on createdAt when a watermark is given', async () => {
    trajectoryFindMany.mockResolvedValue([]);
    await listTrajectoryForRepo('repo-1', { since: '2026-01-01T00:00:00.000Z' });
    expect(trajectoryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          repositoryId: 'repo-1',
          createdAt: { gt: new Date('2026-01-01T00:00:00.000Z') },
        },
      }),
    );
  });

  it('ignores an unparseable watermark rather than filtering everything out', async () => {
    trajectoryFindMany.mockResolvedValue([]);
    await listTrajectoryForRepo('repo-1', { since: 'not-a-date' });
    expect(trajectoryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { repositoryId: 'repo-1' } }),
    );
  });

  it('caps the requested limit', async () => {
    trajectoryFindMany.mockResolvedValue([]);
    await listTrajectoryForRepo('repo-1', { limit: 999_999 });
    expect(trajectoryFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 5_000 }));
  });
});

describe('serializeTrajectoryForEgress', () => {
  const previous = process.env.HAR_TRAJECTORY_MAX_PAYLOAD_BYTES;

  beforeEach(() => {
    if (previous == null) delete process.env.HAR_TRAJECTORY_MAX_PAYLOAD_BYTES;
    else process.env.HAR_TRAJECTORY_MAX_PAYLOAD_BYTES = previous;
  });

  it('serializes timestamps as ISO strings', () => {
    const serialized = serializeTrajectoryForEgress(record() as never);
    expect(serialized.eventTimestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(serialized.createdAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('re-applies a tightened payload cap to already-stored content', () => {
    process.env.HAR_TRAJECTORY_MAX_PAYLOAD_BYTES = '1024';
    const stored = record({ payload: { promptText: 'x'.repeat(20_000), attributes: {} } });

    const serialized = serializeTrajectoryForEgress(stored as never);

    expect((serialized.payload as { promptText: string }).promptText.length).toBeLessThan(20_000);
    expect(serialized.contentDisclosure).toBe('truncated');
  });

  it('redacts a secret attribute a newer policy recognizes', () => {
    const stored = record({
      payload: { attributes: { authorization: 'Bearer abc', 'tool.name': 'Read' } },
    });

    const serialized = serializeTrajectoryForEgress(stored as never);

    const attributes = (serialized.payload as { attributes: Record<string, unknown> }).attributes;
    expect(attributes.authorization).toBe('[redacted]');
    expect(attributes['tool.name']).toBe('Read');
  });

  it('keeps a withheld body absent instead of promising content', () => {
    const stored = record({
      contentDisclosure: 'withheld',
      payload: { promptText: 'secret', attributes: {} },
    });

    const serialized = serializeTrajectoryForEgress(stored as never);

    expect(serialized.contentDisclosure).toBe('withheld');
    expect((serialized.payload as { promptText: unknown }).promptText).toBeNull();
  });

  it('does not weaken a hidden disclosure into truncated', () => {
    process.env.HAR_TRAJECTORY_MAX_PAYLOAD_BYTES = '1024';
    const stored = record({
      contentDisclosure: 'metadata_only',
      payload: { promptText: 'x'.repeat(20_000), attributes: {} },
    });

    expect(serializeTrajectoryForEgress(stored as never).contentDisclosure).toBe('metadata_only');
  });
});

describe('listSessionSpansForRepo', () => {
  beforeEach(() => spanFindMany.mockReset());

  it('reads spans in storage order, watermarked on createdAt', async () => {
    spanFindMany.mockResolvedValue([]);
    await listSessionSpansForRepo('repo-1', { since: '2026-01-01T00:00:00.000Z' });
    expect(spanFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          repositoryId: 'repo-1',
          createdAt: { gt: new Date('2026-01-01T00:00:00.000Z') },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    );
  });
});
