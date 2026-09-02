import type { WorktreeRow } from '@/components/columns/worktree-columns';
import { timeAgo } from '@/lib/time';

export type AttentionKind = 'verify_failed' | 'missing' | 'stale' | 'dirty' | 'no_harness_activity';

export interface AttentionItem {
  kind: AttentionKind;
  severity: 'critical' | 'warning';
  repoId: string;
  repoName: string;
  slotId: number;
  message: string;
}

const REPO_NAME = (path: string) => path.split('/').pop() ?? path;

/**
 * Turn synced slot facts into the short list a developer should look at first.
 * Only active slots can need attention; idle ones are history.
 */
export function attentionItems(rows: WorktreeRow[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const row of rows) {
    if (!row.active) continue;
    const base = { repoId: row.repoId, repoName: REPO_NAME(row.repoPath), slotId: row.slotId };
    if (row.lastVerifyStatus && row.lastVerifyStatus !== 'pass') {
      items.push({ ...base, kind: 'verify_failed', severity: 'critical', message: `Last verify ${row.lastVerifyStatus}` });
    }
    if (row.onDisk === false) {
      items.push({ ...base, kind: 'missing', severity: 'critical', message: 'Worktree path is missing on disk' });
    }
    if (row.stale && (row.behind ?? 0) > 0) {
      items.push({ ...base, kind: 'stale', severity: 'warning', message: `${row.behind} commit${row.behind === 1 ? '' : 's'} behind main` });
    }
    if (row.dirty) {
      items.push({ ...base, kind: 'dirty', severity: 'warning', message: 'Uncommitted changes' });
    }
    if (row.harnessUsage === 'bypass_warning') {
      const since = row.lastRunAt ? ` since ${timeAgo(row.lastRunAt).replace(' ago', '')}` : '';
      items.push({ ...base, kind: 'no_harness_activity', severity: 'warning', message: `No harness activity${since}` });
    }
  }
  const rank = { critical: 0, warning: 1 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity] || a.repoName.localeCompare(b.repoName) || a.slotId - b.slotId);
}
