import * as path from 'path';

const syncRepoWithControlAsync = jest.fn().mockResolvedValue(undefined);
const syncAllKnownReposWithControl = jest.fn().mockResolvedValue({ synced: 0, failed: 0 });

jest.mock('../src/core/control-sync', () => ({
  syncRepoWithControlAsync,
  syncAllKnownReposWithControl,
}));

import {
  hasPendingSync,
  markAllRegisteredDirty,
  markDirty,
  syncDirtyRepos,
} from '../src/core/sync-context';

describe('sync context dirty-set', () => {
  beforeEach(async () => {
    await syncDirtyRepos();
    jest.clearAllMocks();
  });

  it('flushes nothing when no edge marked a repo dirty', async () => {
    expect(hasPendingSync()).toBe(false);
    await syncDirtyRepos();
    expect(syncRepoWithControlAsync).not.toHaveBeenCalled();
    expect(syncAllKnownReposWithControl).not.toHaveBeenCalled();
  });

  it('coalesces repeat marks and syncs each repo once', async () => {
    markDirty('/repos/a');
    markDirty('/repos/a');
    markDirty('/repos/b');
    expect(hasPendingSync()).toBe(true);

    await syncDirtyRepos();

    expect(syncRepoWithControlAsync).toHaveBeenCalledTimes(2);
    expect(syncRepoWithControlAsync).toHaveBeenCalledWith(path.resolve('/repos/a'));
    expect(syncRepoWithControlAsync).toHaveBeenCalledWith(path.resolve('/repos/b'));
    expect(syncAllKnownReposWithControl).not.toHaveBeenCalled();
  });

  it('clears the dirty-set after flushing', async () => {
    markDirty('/repos/a');
    await syncDirtyRepos();
    jest.clearAllMocks();

    expect(hasPendingSync()).toBe(false);
    await syncDirtyRepos();
    expect(syncRepoWithControlAsync).not.toHaveBeenCalled();
  });

  it('expands the all-registered signal to every known repo', async () => {
    markAllRegisteredDirty();
    expect(hasPendingSync()).toBe(true);

    await syncDirtyRepos();

    expect(syncAllKnownReposWithControl).toHaveBeenCalledTimes(1);
  });

  it('never throws when a sync fails, and still clears state', async () => {
    syncRepoWithControlAsync.mockRejectedValueOnce(new Error('boom'));
    markDirty('/repos/a');

    await expect(syncDirtyRepos()).resolves.toBeUndefined();
    expect(hasPendingSync()).toBe(false);
  });
});
