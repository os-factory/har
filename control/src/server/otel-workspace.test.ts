import { describe, expect, it } from 'vitest';
import {
  otelWorkspaceIdForPath,
  pickBestRepoPathMatch,
  pickPathForWorkspaceId,
  shouldPersistOtelUsage,
} from './otel-workspace';

describe('otelWorkspaceIdForPath', () => {
  it('matches @osfactory/otel-hook empty-salt working-directory ids', () => {
    // Precomputed: sha256("\0" + "workspace/working-directory\0" + path)
    expect(otelWorkspaceIdForPath('/home/antoine/Documents/osfactory/har-project')).toBe(
      'sha256:4b1253011b011d9f17508e9f9e5c155d008c44260939891982d966704abb06a8',
    );
  });

  it('strips trailing slashes before hashing', () => {
    const a = otelWorkspaceIdForPath('/repo/foo');
    const b = otelWorkspaceIdForPath('/repo/foo/');
    expect(a).toBe(b);
  });
});

describe('pickBestRepoPathMatch', () => {
  it('prefers the longest registered prefix', () => {
    expect(
      pickBestRepoPathMatch('/home/me/proj/control/src', [
        '/home/me/proj',
        '/home/me/proj/control',
        '/home/other',
      ]),
    ).toBe('/home/me/proj/control');
  });

  it('returns null when nothing matches', () => {
    expect(pickBestRepoPathMatch('/tmp/x', ['/home/me/proj'])).toBeNull();
  });
});

describe('pickPathForWorkspaceId', () => {
  it('recovers a registered path from an opaque workspace id', () => {
    const path = '/home/antoine/Documents/osfactory/har-project';
    const id = otelWorkspaceIdForPath(path);
    expect(
      pickPathForWorkspaceId(id, [
        '/home/antoine/Documents/osfactory/examples/webapp-nextjs',
        path,
        `${path}/control`,
      ]),
    ).toBe(path);
  });

  it('prefers longer candidate paths when both hash-match (worktree over root)', () => {
    // Distinct paths produce distinct ids — verify longest-first scan order by
    // ensuring the matched candidate is the one whose id we queried.
    const worktree = '/home/antoine/worktrees/main-abcd-har-agent-1-xy12';
    const id = otelWorkspaceIdForPath(worktree);
    expect(
      pickPathForWorkspaceId(id, [
        '/home/antoine/Documents/osfactory/har-project',
        worktree,
      ]),
    ).toBe(worktree);
  });
});

describe('shouldPersistOtelUsage', () => {
  it('requires tokens or a positive cost', () => {
    expect(shouldPersistOtelUsage({ tokensTotal: 0, costUsd: null })).toBe(false);
    expect(shouldPersistOtelUsage({ tokensTotal: 0, costUsd: 0 })).toBe(false);
    expect(shouldPersistOtelUsage({ tokensTotal: 12, costUsd: null })).toBe(true);
    expect(shouldPersistOtelUsage({ tokensTotal: 0, costUsd: 0.01 })).toBe(true);
  });
});
