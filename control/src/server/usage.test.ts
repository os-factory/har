import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const findMany = vi.fn();
const findUnique = vi.fn();
const upsert = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    agentSessionUsage: {
      findMany: (...args: unknown[]) => findMany(...args),
      findUnique: (...args: unknown[]) => findUnique(...args),
      upsert: (...args: unknown[]) => upsert(...args),
    },
  },
}));

import { listSessionUsageForRepo, upsertSessionUsage } from './usage';

function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    repositoryId: 'repo-1',
    sessionKey: 'feat/x',
    agentId: 1,
    agentTool: 'claude_code',
    tokensInput: 100n,
    tokensOutput: 40n,
    tokensCacheRead: 60n,
    tokensCacheCreation: 0n,
    tokensTotal: 200n,
    costUsd: null,
    modelBreakdown: null,
    sources: ['harvest'],
    harvestVersion: 0,
    firstSeenAt: new Date('2026-01-01T00:00:00.000Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function harvestInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionKey: 'feat/x',
    agentId: 1,
    agentTool: 'claude_code' as const,
    tokensInput: 50,
    tokensOutput: 20,
    tokensCacheRead: 30,
    tokensCacheCreation: 0,
    tokensTotal: 100,
    sources: ['harvest' as const],
    harvestVersion: 1,
    firstSeenAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

function writtenFields() {
  return upsert.mock.calls[0][0].update;
}

describe('listSessionUsageForRepo', () => {
  beforeEach(() => findMany.mockReset());

  it('scopes the read to the repository id', async () => {
    findMany.mockResolvedValue([]);
    await listSessionUsageForRepo('repo-1');
    expect(findMany).toHaveBeenCalledWith({
      where: { repositoryId: 'repo-1' },
      orderBy: { lastSeenAt: 'desc' },
    });
  });

  it('coerces the JSON sources column back to a string[]', async () => {
    findMany.mockResolvedValue([
      {
        id: 'u1',
        repositoryId: 'repo-1',
        sessionKey: 'feat/gone',
        agentTool: 'claude_code',
        tokensTotal: 4200n,
        sources: ['harvest', 42, 'otel', null],
      },
    ]);
    const rows = await listSessionUsageForRepo('repo-1');
    expect(rows[0].sources).toEqual(['harvest', 'otel']);
  });
});

describe('upsertSessionUsage', () => {
  beforeEach(() => {
    findUnique.mockReset();
    upsert.mockReset();
    upsert.mockResolvedValue({});
  });

  it('lets a newer harvest lower a stored pre-dedupe row', async () => {
    findUnique.mockResolvedValue(storedRow());
    await upsertSessionUsage('repo-1', harvestInput());
    const fields = writtenFields();
    expect(fields.tokensInput).toBe(50n);
    expect(fields.tokensTotal).toBe(100n);
    expect(fields.harvestVersion).toBe(1);
  });

  it('keeps max-merge for a partial re-read at the same version', async () => {
    findUnique.mockResolvedValue(storedRow({ harvestVersion: 1 }));
    await upsertSessionUsage('repo-1', harvestInput());
    const fields = writtenFields();
    expect(fields.tokensInput).toBe(100n);
    expect(fields.tokensTotal).toBe(200n);
    expect(fields.harvestVersion).toBe(1);
  });

  it('does not replace a row OTLP contributed to', async () => {
    findUnique.mockResolvedValue(storedRow({ sources: ['harvest', 'otel'] }));
    await upsertSessionUsage('repo-1', harvestInput());
    const fields = writtenFields();
    expect(fields.tokensTotal).toBe(200n);
    expect(fields.harvestVersion).toBe(0);
  });

  it('drops the stored cost and model breakdown when superseded', async () => {
    findUnique.mockResolvedValue(
      storedRow({
        costUsd: 9.5,
        modelBreakdown: { 'claude-opus-5': { tokensTotal: 200, costUsd: 9.5 } },
      }),
    );
    await upsertSessionUsage(
      'repo-1',
      harvestInput({
        costUsd: 4.25,
        modelBreakdown: { 'claude-opus-5': { tokensTotal: 100, costUsd: 4.25 } },
      }),
    );
    const fields = writtenFields();
    expect(Number(fields.costUsd)).toBe(4.25);
    expect(fields.modelBreakdown).toEqual({ 'claude-opus-5': { tokensTotal: 100, costUsd: 4.25 } });
  });

  it('clears a stored model breakdown the superseding harvest no longer reports', async () => {
    findUnique.mockResolvedValue(
      storedRow({
        costUsd: 9.5,
        modelBreakdown: { 'claude-opus-5': { tokensTotal: 200, costUsd: 9.5 } },
      }),
    );
    await upsertSessionUsage('repo-1', harvestInput({ costUsd: 4.25 }));
    const fields = writtenFields();
    expect(fields.modelBreakdown).toBe(Prisma.JsonNull);
    expect(Number(fields.costUsd)).toBe(4.25);
  });

  it('leaves a stored model breakdown alone on a same-version merge', async () => {
    findUnique.mockResolvedValue(
      storedRow({
        harvestVersion: 1,
        modelBreakdown: { 'claude-opus-5': { tokensTotal: 200 } },
      }),
    );
    await upsertSessionUsage('repo-1', harvestInput());
    expect(writtenFields().modelBreakdown).toEqual({
      'claude-opus-5': { tokensTotal: 200 },
    });
  });

  it('stamps the incoming version on a session it has never seen', async () => {
    findUnique.mockResolvedValue(null);
    await upsertSessionUsage('repo-1', harvestInput());
    expect(upsert.mock.calls[0][0].create.harvestVersion).toBe(1);
  });
});
