import { AsyncLocalStorage } from 'async_hooks';

/**
 * Bounded HTTP for Mission Control / HQ sync.
 *
 * Every request gets its own timeout, and a sync run under `runWithDeadline`
 * shares one abort signal: when the deadline passes, the in-flight request is
 * cancelled and no further request starts. Without it a timed-out sync kept
 * posting (and advancing watermarks) in the background while the caller had
 * already reported it as failed and moved on to the next repo.
 */

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

const deadlineSignal = new AsyncLocalStorage<AbortSignal>();

export class SyncDeadlineError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'SyncDeadlineError';
  }
}

export function syncRequestTimeoutMs(): number {
  const raw = Number(process.env.HAR_SYNC_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REQUEST_TIMEOUT_MS;
}

/** Throws the deadline's reason when the surrounding sync has run out of time. */
export function throwIfSyncAborted(): void {
  const signal = deadlineSignal.getStore();
  if (signal?.aborted) throw signal.reason;
}

/** `fetch` bounded by a per-request timeout and the surrounding sync deadline. */
export async function syncFetch(
  url: string,
  init: RequestInit = {},
  timeoutMs = syncRequestTimeoutMs(),
): Promise<Response> {
  throwIfSyncAborted();
  const deadline = deadlineSignal.getStore();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = deadline ? AbortSignal.any([deadline, timeout]) : timeout;
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    if (deadline?.aborted) throw deadline.reason;
    if (timeout.aborted) {
      throw new Error(`request timed out after ${timeoutMs}ms`, { cause: err });
    }
    throw err;
  }
}

/**
 * Run `work` with a deadline that cancels its requests, not just the wait.
 * Rejects with `SyncDeadlineError` once `ms` elapse.
 */
export async function runWithDeadline<T>(
  work: () => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new SyncDeadlineError(label, ms);
      controller.abort(reason);
      reject(reason);
    }, ms);
  });
  try {
    return await Promise.race([deadlineSignal.run(controller.signal, work), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Statuses worth one more try: rate limits and gateway / overload errors. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** Delay before the next attempt, honouring a numeric `Retry-After` up to 5s. */
export function retryDelayMs(attempt: number, response?: Response): number {
  const header = Number(response?.headers.get('retry-after'));
  if (Number.isFinite(header) && header >= 0) return Math.min(header * 1000, 5_000);
  return attempt * 250;
}
