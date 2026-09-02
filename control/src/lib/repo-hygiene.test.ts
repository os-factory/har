import { describe, expect, it } from 'vitest';
import { classifyRepositoryVisibility, isTemporaryPath } from './repo-hygiene';

describe('isTemporaryPath', () => {
  it('flags the usual temp roots and the platform tmpdir', () => {
    expect(isTemporaryPath('/tmp/har-lab-62g8mJ/repo', '/tmp')).toBe(true);
    expect(isTemporaryPath('/private/tmp/x/fixture', '/tmp')).toBe(true);
    expect(isTemporaryPath('/var/folders/ab/T/har-lab/repo', '/tmp')).toBe(true);
    expect(isTemporaryPath('/scratch/run-1/repo', '/scratch')).toBe(true);
  });

  it('keeps real checkouts', () => {
    expect(isTemporaryPath('/home/antoine/Documents/osfactory/har-project', '/tmp')).toBe(false);
    expect(isTemporaryPath('/home/antoine/tmp-notes/repo', '/tmp')).toBe(false);
  });
});

describe('classifyRepositoryVisibility', () => {
  it('hides temporary paths regardless of disk state', () => {
    expect(
      classifyRepositoryVisibility({
        path: '/tmp/har-lab/repo',
        onDisk: true,
        hostPathsVisible: true,
        tmpdir: '/tmp',
      }),
    ).toEqual({ hidden: true, reason: 'temporary' });
  });

  it('hides missing paths only when host paths are visible at all', () => {
    const base = { path: '/home/dev/repo', onDisk: false, tmpdir: '/tmp' };
    expect(classifyRepositoryVisibility({ ...base, hostPathsVisible: true })).toEqual({
      hidden: true,
      reason: 'missing',
    });
    expect(classifyRepositoryVisibility({ ...base, hostPathsVisible: false })).toEqual({
      hidden: false,
    });
  });
});
