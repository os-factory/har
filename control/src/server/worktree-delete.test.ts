import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const findUnique = vi.fn();
const deleteSlot = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    agentSlot: {
      findUnique: (...args: unknown[]) => findUnique(...args),
      delete: (...args: unknown[]) => deleteSlot(...args),
    },
  },
}));

import { deleteSessionWorktrees } from './worktree-delete';

describe('deleteSessionWorktrees', () => {
  const temps: string[] = [];

  beforeEach(() => {
    findUnique.mockReset();
    deleteSlot.mockReset();
  });

  afterEach(() => {
    for (const dir of temps) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    temps.length = 0;
  });

  it('refuses to delete the repository main checkout', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-wt-main-'));
    temps.push(repo);
    findUnique.mockResolvedValue({
      id: 'slot-1',
      slotId: 1,
      worktreePath: repo,
      workDir: repo,
      repository: { id: 'repo-1', path: repo },
    });

    const result = await deleteSessionWorktrees({
      worktrees: [{ repoId: 'repo-1', slotId: 1 }],
    });

    expect(result.results[0]?.deleted).toBe(false);
    expect(result.results[0]?.error).toMatch(/main checkout/i);
    expect(deleteSlot).not.toHaveBeenCalled();
  });

  it('deletes a worktree directory and clears the dashboard row', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'har-wt-root-'));
    temps.push(root);
    const repo = path.join(root, 'repo');
    const worktree = path.join(root, 'wt');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, 'file.txt'), 'x');

    findUnique.mockResolvedValue({
      id: 'slot-2',
      slotId: 2,
      worktreePath: worktree,
      workDir: worktree,
      repository: { id: 'repo-1', path: repo },
    });
    deleteSlot.mockResolvedValue({});

    const result = await deleteSessionWorktrees({
      worktrees: [{ repoId: 'repo-1', slotId: 2 }],
    });

    expect(result.results[0]?.deleted).toBe(true);
    expect(result.results[0]?.clearedFromDashboard).toBe(true);
    expect(fs.existsSync(worktree)).toBe(false);
    expect(deleteSlot).toHaveBeenCalledWith({ where: { id: 'slot-2' } });
  });

  it('clears missing paths from the dashboard when clearMissing is true', async () => {
    findUnique.mockResolvedValue({
      id: 'slot-3',
      slotId: 3,
      worktreePath: '/tmp/definitely-missing-har-worktree-xyz',
      workDir: null,
      repository: { id: 'repo-1', path: '/tmp/some-repo' },
    });
    deleteSlot.mockResolvedValue({});

    const result = await deleteSessionWorktrees({
      worktrees: [{ repoId: 'repo-1', slotId: 3 }],
      clearMissing: true,
    });

    expect(result.results[0]?.deleted).toBe(true);
    expect(result.results[0]?.clearedFromDashboard).toBe(true);
    expect(deleteSlot).toHaveBeenCalled();
  });
});
