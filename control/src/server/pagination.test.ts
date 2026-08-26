import { describe, expect, it } from 'vitest';
import { clampPageLimit, createdAtKeyset, pageParams } from './pagination';

describe('createdAtKeyset', () => {
  it('matches everything without a watermark', () => {
    expect(createdAtKeyset({})).toEqual({});
    expect(createdAtKeyset({ since: null })).toEqual({});
  });

  it('ignores an unparseable watermark rather than dropping every row', () => {
    expect(createdAtKeyset({ since: 'not-a-date' })).toEqual({});
  });

  it('filters on createdAt alone when no cursor id is given', () => {
    expect(createdAtKeyset({ since: '2026-01-01T00:00:00.000Z' })).toEqual({
      createdAt: { gt: new Date('2026-01-01T00:00:00.000Z') },
    });
  });

  it('pages on (createdAt, id) so a same-millisecond batch is not skipped', () => {
    expect(createdAtKeyset({ since: '2026-01-01T00:00:00.000Z', sinceId: 'row-2' })).toEqual({
      OR: [
        { createdAt: { gt: new Date('2026-01-01T00:00:00.000Z') } },
        { createdAt: new Date('2026-01-01T00:00:00.000Z'), id: { gt: 'row-2' } },
      ],
    });
  });
});

describe('clampPageLimit', () => {
  it('falls back when no limit is requested', () => {
    expect(clampPageLimit(undefined, 1_000, 5_000)).toBe(1_000);
  });

  it('caps a greedy request and floors a useless one', () => {
    expect(clampPageLimit(999_999, 1_000, 5_000)).toBe(5_000);
    expect(clampPageLimit(0, 1_000, 5_000)).toBe(1);
  });
});

describe('pageParams', () => {
  it('reads the cursor and limit off the query', () => {
    const url = new URL('http://x/api?since=2026-01-01T00:00:00.000Z&sinceId=row-1&limit=250');
    expect(pageParams(url)).toEqual({
      since: '2026-01-01T00:00:00.000Z',
      sinceId: 'row-1',
      limit: 250,
    });
  });

  it('omits a non-numeric limit so the lister keeps its default', () => {
    expect(pageParams(new URL('http://x/api?limit=abc'))).toEqual({ since: null, sinceId: null });
  });
});
