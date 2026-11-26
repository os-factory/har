import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
  listLinkedWorktrees: () => [],
}));

import {
  coveredSources,
  readRunsWatermarkEntry,
  selectSince,
  writeRunsWatermark,
} from '../src/core/sync-watermark';

describe('runs watermark store', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'har-sync-watermark-'));
    process.env.HAR_PORTAL_SYNC_STATE_PATH = path.join(tempHome, 'portal-sync-state.json');
  });

  afterEach(() => {
    delete process.env.HAR_PORTAL_SYNC_STATE_PATH;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns null before any sync', () => {
    expect(readRunsWatermarkEntry('/repo/a', 'runs:http://mc')).toBeNull();
  });

  it('keys independently by repo and by target, and upserts in place', () => {
    writeRunsWatermark('/repo/a', 'runs:http://mc1', 'r1', '2026-01-01T00:00:00.000Z');
    writeRunsWatermark('/repo/a', 'runs:http://mc2', 'r2', '2026-02-01T00:00:00.000Z');
    writeRunsWatermark('/repo/a', 'runs:http://mc1', 'r1', '2026-05-01T00:00:00.000Z');
    expect(readRunsWatermarkEntry('/repo/a', 'runs:http://mc1')).toMatchObject({
      lastSyncedAt: '2026-05-01T00:00:00.000Z',
      repoId: 'r1',
    });
    expect(readRunsWatermarkEntry('/repo/a', 'runs:http://mc2')?.lastSyncedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(readRunsWatermarkEntry('/repo/b', 'runs:http://mc1')).toBeNull();
  });

  it('remembers the sources a watermark covers', () => {
    expect(coveredSources('/repo/a', null)).toEqual(['/repo/a']);
    writeRunsWatermark('/repo/a', 'runs:http://mc', 'r1', '2026-01-01T00:00:00.000Z', ['/ws/b']);
    expect(coveredSources('/repo/a', readRunsWatermarkEntry('/repo/a', 'runs:http://mc'))).toEqual([
      '/repo/a',
      '/ws/b',
    ]);
  });
});

describe('selectSince', () => {
  const rows = [
    { key: 'a', ts: '2026-01-01T00:00:00.000Z' },
    { key: 'b', ts: '2026-03-01T00:00:00.000Z' },
    { key: 'c', ts: '2026-02-01T00:00:00.000Z' },
  ];
  const getTs = (r: { ts: string }) => r.ts;

  it('selects everything and reports the max when since is null', () => {
    const result = selectSince(rows, null, getTs);
    expect(result.selected.map((r) => r.key)).toEqual(['a', 'b', 'c']);
    expect(result.maxSyncedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('selects only rows newer than since and advances to the max sent', () => {
    const result = selectSince(rows, '2026-01-15T00:00:00.000Z', getTs);
    expect(result.selected.map((r) => r.key)).toEqual(['b', 'c']);
    expect(result.maxSyncedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('selects nothing (max null) when all rows are at or before since', () => {
    const result = selectSince(rows, '2026-06-01T00:00:00.000Z', getTs);
    expect(result.selected).toEqual([]);
    expect(result.maxSyncedAt).toBeNull();
  });

  it('always includes rows without a comparable timestamp', () => {
    const mixed = [{ key: 'x', ts: undefined }, { key: 'y', ts: '2026-01-01T00:00:00.000Z' }];
    const result = selectSince(mixed, '2026-05-01T00:00:00.000Z', (r) => r.ts);
    expect(result.selected.map((r) => r.key)).toEqual(['x']);
    expect(result.maxSyncedAt).toBeNull();
  });
});
