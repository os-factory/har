import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findUniqueUnregistered = vi.fn();
const upsertUnregistered = vi.fn();
const deleteUnregistered = vi.fn();
const findUniqueRepository = vi.fn();
const upsertRepository = vi.fn();
const deleteRepositoryRow = vi.fn();
const deleteManyRepository = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    unregisteredRepository: {
      findUnique: (...args: unknown[]) => findUniqueUnregistered(...args),
      upsert: (...args: unknown[]) => upsertUnregistered(...args),
      delete: (...args: unknown[]) => deleteUnregistered(...args),
    },
    repository: {
      findUnique: (...args: unknown[]) => findUniqueRepository(...args),
      upsert: (...args: unknown[]) => upsertRepository(...args),
      delete: (...args: unknown[]) => deleteRepositoryRow(...args),
      deleteMany: (...args: unknown[]) => deleteManyRepository(...args),
    },
  },
}));

vi.mock('@/server/git-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => (p === '/tmp/worktree' ? '/tmp/main' : p),
}));

vi.mock('@/server/worktree-cleanup', () => ({
  cleanupSessionWorktrees: () => [],
}));

import {
  deleteRepository,
  registerRepository,
  RepositoryUnregisteredError,
} from './repositories';

describe('registerRepository tombstone', () => {
  beforeEach(() => {
    findUniqueUnregistered.mockReset();
    upsertUnregistered.mockReset();
    deleteUnregistered.mockReset();
    upsertRepository.mockReset();
    deleteManyRepository.mockReset();
    upsertRepository.mockResolvedValue({ id: 'repo-1', path: '/tmp/main' });
    deleteManyRepository.mockResolvedValue({ count: 0 });
  });

  it('blocks re-register when path is tombstoned', async () => {
    findUniqueUnregistered.mockResolvedValue({
      path: '/tmp/main',
      unregisteredAt: new Date(),
      deleteWorktrees: false,
    });

    await expect(
      registerRepository({ path: '/tmp/main', gitRemote: 'https://example.com/a.git' }),
    ).rejects.toBeInstanceOf(RepositoryUnregisteredError);

    expect(upsertRepository).not.toHaveBeenCalled();
  });

  it('checks tombstone against canonical path for linked worktrees', async () => {
    findUniqueUnregistered.mockResolvedValue({
      path: '/tmp/main',
      unregisteredAt: new Date(),
      deleteWorktrees: false,
    });

    await expect(
      registerRepository({ path: '/tmp/worktree', gitRemote: 'https://example.com/a.git' }),
    ).rejects.toMatchObject({ path: '/tmp/main' });

    expect(findUniqueUnregistered).toHaveBeenCalledWith({ where: { path: '/tmp/main' } });
  });

  it('force register clears tombstone and upserts repository', async () => {
    findUniqueUnregistered.mockResolvedValue({
      path: '/tmp/main',
      unregisteredAt: new Date(),
      deleteWorktrees: false,
    });
    deleteUnregistered.mockResolvedValue({});
    upsertRepository.mockResolvedValue({ id: 'repo-2', path: '/tmp/main' });

    const repo = await registerRepository({
      path: '/tmp/main',
      gitRemote: 'https://example.com/a.git',
      force: true,
    });

    expect(deleteUnregistered).toHaveBeenCalledWith({ where: { path: '/tmp/main' } });
    expect(upsertRepository).toHaveBeenCalled();
    expect(repo.path).toBe('/tmp/main');
  });

  it('allows register when no tombstone exists', async () => {
    findUniqueUnregistered.mockResolvedValue(null);

    await registerRepository({ path: '/tmp/main', gitRemote: 'https://example.com/a.git' });

    expect(deleteUnregistered).not.toHaveBeenCalled();
    expect(upsertRepository).toHaveBeenCalled();
  });
});

describe('deleteRepository tombstone', () => {
  beforeEach(() => {
    findUniqueRepository.mockReset();
    upsertUnregistered.mockReset();
    deleteRepositoryRow.mockReset();
    upsertUnregistered.mockResolvedValue({});
    deleteRepositoryRow.mockResolvedValue({});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('writes tombstone before deleting repository row', async () => {
    findUniqueRepository.mockResolvedValue({
      id: 'repo-1',
      path: '/tmp/main',
      slots: [],
    });

    const result = await deleteRepository('repo-1');

    expect(upsertUnregistered).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { path: '/tmp/main' },
        create: expect.objectContaining({ path: '/tmp/main' }),
      }),
    );
    expect(deleteRepositoryRow).toHaveBeenCalledWith({ where: { id: 'repo-1' } });
    expect(result).toMatchObject({ ok: true, path: '/tmp/main' });
  });

  it('returns null when repository does not exist', async () => {
    findUniqueRepository.mockResolvedValue(null);

    await expect(deleteRepository('missing')).resolves.toBeNull();
    expect(upsertUnregistered).not.toHaveBeenCalled();
  });
});

describe('RepositoryUnregisteredError', () => {
  it('exposes path for API 409 responses', () => {
    const err = new RepositoryUnregisteredError('/tmp/main');
    expect(err.path).toBe('/tmp/main');
    expect(err.message).toContain('/tmp/main');
    expect(err.message).toContain('--force');
  });
});
