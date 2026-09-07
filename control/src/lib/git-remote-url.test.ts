import { describe, expect, it } from 'vitest';
import { gitRemoteBrowseUrl, gitRemoteCommitUrl } from './git-remote-url';

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

describe('gitRemoteCommitUrl (#340)', () => {
  it('points GitHub and GitLab remotes at /commit/<sha>', () => {
    expect(gitRemoteCommitUrl('https://github.com/os-factory/har.git', 'abc1234')).toBe(
      'https://github.com/os-factory/har/commit/abc1234',
    );
    expect(gitRemoteCommitUrl('git@gitlab.com:acme/app.git', 'def5678')).toBe(
      'https://gitlab.com/acme/app/commit/def5678',
    );
  });

  it('points Bitbucket remotes at /commits/<sha>', () => {
    expect(gitRemoteCommitUrl('git@bitbucket.org:acme/app.git', 'abc1234')).toBe(
      'https://bitbucket.org/acme/app/commits/abc1234',
    );
  });

  it('returns null without a remote or sha', () => {
    expect(gitRemoteCommitUrl(null, 'abc')).toBeNull();
    expect(gitRemoteCommitUrl('https://github.com/os-factory/har.git', null)).toBeNull();
  });
});
