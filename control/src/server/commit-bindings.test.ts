import { beforeEach, describe, expect, it, vi } from 'vitest';

const upsert = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    validationCommitBinding: {
      upsert: (...args: unknown[]) => upsert(...args),
    },
  },
}));

import { syncCommitBindings } from './commit-bindings';

const treeHash = 'a'.repeat(40);
const commitSha = 'b'.repeat(40);

function binding(bindingId: string, validationId: string, createdAt: string) {
  return { bindingId, validationId, treeHash, commitSha, createdAt };
}

describe('syncCommitBindings', () => {
  beforeEach(() => {
    upsert.mockReset();
  });

  it('keys each binding on its tree and commit, so a second worktree overwrites the first', async () => {
    const fromMainCheckout = binding(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      '2026-11-12T10:00:00.000Z',
    );
    const fromSlotWorktree = binding(
      '33333333-3333-4333-8333-333333333333',
      '44444444-4444-4444-8444-444444444444',
      '2026-11-12T11:00:00.000Z',
    );

    const result = await syncCommitBindings('repo-1', {
      bindings: [fromMainCheckout, fromSlotWorktree],
    });

    expect(result).toEqual({ synced: 2 });
    expect(upsert).toHaveBeenCalledTimes(2);
    for (const [call] of upsert.mock.calls) {
      expect(call.where).toEqual({
        repositoryId_treeHash_commitSha: { repositoryId: 'repo-1', treeHash, commitSha },
      });
    }
    const second = upsert.mock.calls[1][0];
    expect(second.update).toMatchObject({
      bindingId: fromSlotWorktree.bindingId,
      validationId: fromSlotWorktree.validationId,
      sourceCreatedAt: new Date(fromSlotWorktree.createdAt),
    });
    expect(second.create).toMatchObject({
      repositoryId: 'repo-1',
      bindingId: fromSlotWorktree.bindingId,
    });
  });
});
