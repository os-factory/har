import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../src/core/control-repo-path', () => ({
  canonicalizeControlRepoPath: (p: string) => p,
}));

import {
  getPortalWatermarkPath,
  readPortalWatermark,
  selectSince,
  writePortalWatermark,
} from '../src/core/portal-watermark';

describe('portal watermark store', () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'har-portal-watermark-'));
    process.env.HAR_PORTAL_SYNC_STATE_PATH = path.join(tempHome, 'portal-sync-state.json');
  });

  afterEach(() => {
    delete process.env.HAR_PORTAL_SYNC_STATE_PATH;
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns null before any sync', () => {
    expect(readPortalWatermark('/repo/a', 'https://portal.example.com')).toBeNull();
  });

  it('round-trips a watermark per (repo, portal)', () => {
    writePortalWatermark('/repo/a', 'https://p1.example.com', '2026-01-02T00:00:00.000Z');
    expect(fs.existsSync(getPortalWatermarkPath())).toBe(true);
    expect(readPortalWatermark('/repo/a', 'https://p1.example.com')).toBe(
      '2026-01-02T00:00:00.000Z',
    );
  });

  it('keys independently by repo and by portal', () => {
    writePortalWatermark('/repo/a', 'https://p1.example.com', '2026-01-01T00:00:00.000Z');
    writePortalWatermark('/repo/a', 'https://p2.example.com', '2026-02-01T00:00:00.000Z');
    writePortalWatermark('/repo/b', 'https://p1.example.com', '2026-03-01T00:00:00.000Z');

    expect(readPortalWatermark('/repo/a', 'https://p1.example.com')).toBe('2026-01-01T00:00:00.000Z');
    expect(readPortalWatermark('/repo/a', 'https://p2.example.com')).toBe('2026-02-01T00:00:00.000Z');
    expect(readPortalWatermark('/repo/b', 'https://p1.example.com')).toBe('2026-03-01T00:00:00.000Z');
  });

  it('upserts the same (repo, portal) in place', () => {
    writePortalWatermark('/repo/a', 'https://p1.example.com', '2026-01-01T00:00:00.000Z');
    writePortalWatermark('/repo/a', 'https://p1.example.com', '2026-05-01T00:00:00.000Z');
    expect(readPortalWatermark('/repo/a', 'https://p1.example.com')).toBe('2026-05-01T00:00:00.000Z');
    const parsed = JSON.parse(fs.readFileSync(getPortalWatermarkPath(), 'utf8'));
    expect(parsed.states).toHaveLength(1);
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
