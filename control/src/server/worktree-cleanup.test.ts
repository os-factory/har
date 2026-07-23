import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupSessionWorktrees } from './worktree-cleanup';

describe('cleanupSessionWorktrees', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    temps.length = 0;
  });

  it('reports invisible paths without throwing', () => {
    const results = cleanupSessionWorktrees('/tmp/does-not-exist-repo', [
      { agentId: 1, worktreePath: '/tmp/definitely-missing-har-worktree' },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.deleted).toBe(false);
    expect(results[0]?.error).toMatch(/not visible|CLI/i);
  });

  it('removes an existing directory fallback', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-wt-clean-'));
    temps.push(dir);
    const results = cleanupSessionWorktrees('/tmp/does-not-exist-repo', [
      { agentId: 2, worktreePath: dir },
    ]);
    expect(results[0]?.deleted).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });
});
