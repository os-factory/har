import { describe, expect, it } from 'vitest';
import { gitRemoteBrowseUrl } from './git-remote-url';

describe('gitRemoteBrowseUrl', () => {
  it('keeps https remotes and strips .git', () => {
    expect(gitRemoteBrowseUrl('https://github.com/os-factory/har.git')).toBe(
      'https://github.com/os-factory/har',
    );
  });

  it('converts ssh remotes', () => {
    expect(gitRemoteBrowseUrl('git@github.com:os-factory/har.git')).toBe(
      'https://github.com/os-factory/har',
    );
  });

  it('returns null for empty or unknown forms', () => {
    expect(gitRemoteBrowseUrl(null)).toBeNull();
    expect(gitRemoteBrowseUrl('')).toBeNull();
    expect(gitRemoteBrowseUrl('file:///tmp/repo')).toBeNull();
  });
});
