import * as path from 'path';

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 250;
const DEFAULT_PAGE_SIZE = 1_000;
const MAX_PAGES = 20;

export type ControlRead<T> = { ok: true; data: T } | { ok: false; error: string };

export type PagedControlRead<Row> =
  | { ok: true; rows: Row[]; truncated: boolean }
  | { ok: false; error: string };

export interface ChannelReadFailure {
  channel: string;
  reason: string;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

async function attempt<T>(url: string): Promise<{ read: ControlRead<T>; retryable: boolean }> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(numberFromEnv('HAR_CONTROL_READ_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)),
    });
    if (!response.ok) {
      return {
        read: { ok: false, error: `HTTP ${response.status}` },
        retryable: response.status >= 500,
      };
    }
    return { read: { ok: true, data: (await response.json()) as T }, retryable: false };
  } catch (err: unknown) {
    return {
      read: { ok: false, error: err instanceof Error ? err.message : String(err) },
      retryable: true,
    };
  }
}

export async function readControlJson<T>(url: string): Promise<ControlRead<T>> {
  const first = await attempt<T>(url);
  if (first.read.ok || !first.retryable) return first.read;
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  return (await attempt<T>(url)).read;
}

export async function readControlPages<Row>(options: {
  url: string;
  since: string | null;
  rows: (data: unknown) => Row[];
  cursor: (row: Row) => { createdAt?: string | null; id?: string | null };
}): Promise<PagedControlRead<Row>> {
  const limit = numberFromEnv('HAR_CONTROL_READ_PAGE_SIZE', DEFAULT_PAGE_SIZE);
  const collected: Row[] = [];
  let since = options.since;
  let sinceId: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const query = new URLSearchParams({ limit: String(limit) });
    if (since) query.set('since', since);
    if (sinceId) query.set('sinceId', sinceId);

    const read = await readControlJson<unknown>(`${options.url}?${query.toString()}`);
    if (!read.ok) return { ok: false, error: read.error };

    const rows = options.rows(read.data);
    collected.push(...rows);
    if (rows.length < limit) return { ok: true, rows: collected, truncated: false };

    const last = options.cursor(rows[rows.length - 1]);
    const nextSince = last.createdAt ?? null;
    const nextSinceId = last.id ?? null;
    if (!nextSince || (nextSince === since && nextSinceId === sinceId)) {
      return { ok: true, rows: collected, truncated: false };
    }
    since = nextSince;
    sinceId = nextSinceId;
  }

  return { ok: true, rows: collected, truncated: true };
}

export async function resolveControlRepoId(
  apiUrl: string,
  repoPath: string,
): Promise<ControlRead<string | null>> {
  const repos = await readControlJson<{ id: string; path: string }[]>(`${apiUrl}/api/repos`);
  if (!repos.ok) return repos;
  if (!Array.isArray(repos.data)) return { ok: false, error: 'unexpected /api/repos payload' };
  const target = path.resolve(repoPath);
  return {
    ok: true,
    data: repos.data.find((repo) => path.resolve(repo.path) === target)?.id ?? null,
  };
}
