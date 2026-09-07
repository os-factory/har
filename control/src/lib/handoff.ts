import type { TimelineRow } from '@/lib/slot-timeline';

export interface MatchingCommit {
  sha: string;
  branch: string | null;
}

/**
 * The commit a live attempt can hand off: prefer the newest verified-tree
 * commit, otherwise the newest commit on the timeline (#340).
 */
export function matchingCommit(timeline: TimelineRow[]): MatchingCommit | null {
  const commits = timeline.filter((row) => row.kind === 'commit' && row.commit);
  const verified = commits.find((row) => row.status === 'Verified tree');
  const row = verified ?? commits[0];
  if (!row?.commit) return null;
  return { sha: row.commit.sha, branch: row.commit.branch ?? row.branch };
}
