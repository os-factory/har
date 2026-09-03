import { describe, expect, it } from 'vitest';
import { filterUsageRows } from './usage-filters';

const now = new Date('2026-09-03T12:00:00Z');
const rows = [
  { id: 'a', repositoryId: 'r1', lastSeenAt: new Date('2026-09-03T10:00:00Z') },
  { id: 'b', repositoryId: 'r2', lastSeenAt: new Date('2026-08-30T10:00:00Z') },
  { id: 'c', repositoryId: 'r1', lastSeenAt: '2026-07-01T10:00:00Z' },
];

describe('filterUsageRows (#339)', () => {
  it('keeps everything by default', () => {
    expect(filterUsageRows(rows, { repositoryId: null, period: 'all', now }).map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });
  it('filters by repository and period together', () => {
    expect(filterUsageRows(rows, { repositoryId: 'r1', period: 'all', now }).map((r) => r.id)).toEqual(['a', 'c']);
    expect(filterUsageRows(rows, { repositoryId: null, period: '7d', now }).map((r) => r.id)).toEqual(['a', 'b']);
    expect(filterUsageRows(rows, { repositoryId: 'r1', period: '1d', now }).map((r) => r.id)).toEqual(['a']);
  });
});
