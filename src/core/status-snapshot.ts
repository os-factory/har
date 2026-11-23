import { AsyncLocalStorage } from 'async_hooks';

/**
 * One consistent read of the machine for the duration of a sync.
 *
 * A Mission Control / HQ sync collects slot status for every source of a repo
 * (the canonical checkout and each linked worktree with its own `.har`), and
 * both legs used to collect it again. Every pass re-ran `pm2 jlist` (machine
 * wide, ~0.6s through the package runner) and two `git rev-parse` per
 * `~/worktrees/*-har-agent-N-*` directory on the machine, for every free
 * slot. On a repo with a few worktrees that took most of the 15s budget of
 * the sync after a harness command.
 *
 * Inside `withStatusSnapshot`, `snapshotMemo` computes each key once; outside
 * it, it computes every time, so status everywhere else stays live.
 */
const snapshot = new AsyncLocalStorage<Map<string, unknown>>();

export function withStatusSnapshot<T>(work: () => T): T {
  return snapshot.getStore() ? work() : snapshot.run(new Map(), work);
}

export function snapshotMemo<T>(key: string, compute: () => T): T {
  const store = snapshot.getStore();
  if (!store) return compute();
  if (store.has(key)) return store.get(key) as T;
  const value = compute();
  store.set(key, value);
  return value;
}
