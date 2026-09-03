import { timeAgo } from '@/lib/time';

export type HealthTone = 'pass' | 'warn' | 'fail' | 'neutral';

export interface SlotHealthInput {
  active: boolean;
  onDisk?: boolean;
  detachedHead: boolean | null;
  dirty: boolean | null;
  ahead: number | null;
  behind: number | null;
  stale: boolean | null;
  baseBranch: string | null;
  branch: string | null;
  /** Cleanup advice for idle worktrees (Now page); folded into the sentence. */
  cleanupHint?: string | null;
}

export interface HealthCell {
  text: string;
  tone: HealthTone;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One sentence instead of Status · Drift · Harness · Build · Cleanup columns (#339):
 * "Active · 2 commits ahead, 113 behind main, uncommitted changes".
 */
export function describeSlotHealth(row: SlotHealthInput): HealthCell {
  if (row.onDisk === false) {
    return {
      text: `${row.active ? 'Active' : 'Idle'} · worktree path missing on disk`,
      tone: row.active ? 'fail' : 'warn',
    };
  }
  if (!row.active) {
    const hint = row.cleanupHint ? ` · ${row.cleanupHint}` : row.branch ? ` · last ${row.branch}` : '';
    return { text: `Idle${hint}`, tone: 'neutral' };
  }
  const parts: string[] = [];
  let tone: HealthTone = 'pass';
  if (row.detachedHead) {
    parts.push('detached HEAD');
    tone = 'fail';
  }
  if ((row.ahead ?? 0) > 0) parts.push(`${plural(row.ahead!, 'commit')} ahead`);
  if (row.stale) {
    parts.push(`${row.behind ?? '?'} behind ${row.baseBranch ?? 'main'}`);
    if (tone === 'pass') tone = 'warn';
  }
  if (row.dirty) {
    parts.push('uncommitted changes');
    if (tone === 'pass') tone = 'warn';
  }
  return { text: `Active · ${parts.length ? parts.join(', ') : 'clean'}`, tone };
}

export interface SlotVerifyInput {
  lastVerifyStatus: string | null;
  /** Start of the latest *verify* run of the current occupancy — never a launch or teardown. */
  lastVerifyAt: Date | string | null;
  now?: Date;
}

/** "Verified 14 min ago" / "Verify failed 2 h ago" / "Not verified" (#339). */
export function describeSlotVerify(row: SlotVerifyInput): HealthCell {
  const when = row.lastVerifyAt ? ` ${timeAgo(row.lastVerifyAt, row.now)}` : '';
  switch (row.lastVerifyStatus) {
    case 'pass':
      return { text: `Verified${when}`, tone: 'pass' };
    case 'bypass_warning':
      return { text: `Verify bypassed${when}`, tone: 'warn' };
    case null:
    case undefined:
    case '':
      return { text: 'Not verified', tone: 'neutral' };
    default:
      return { text: `Verify ${row.lastVerifyStatus}${when}`, tone: 'fail' };
  }
}
