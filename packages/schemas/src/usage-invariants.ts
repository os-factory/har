import { dedupeProducers, priceObservation, type ObservationFact } from './usage-attribution';

/**
 * Usage invariants (FE-2058): pure checks over what Mission Control stores and
 * serves — the usage `har control sync` ships to HAR HQ. One definition, used
 * by the tests, Mission Control (`GET /api/usage/invariants`),
 * `har control check-usage` and the sync gate. Each check guards a failure the
 * usage audit found, and reports the usage it miscounts (`tokens`, `costUsd`).
 *
 * The blocking ones count usage twice: `har control sync` leaves the sessions
 * (or legacy rows) that break them out of the HQ post.
 */
export const USAGE_INVARIANTS = {
  I1: {
    name: 'request-in-one-repository',
    blocking: true,
    description:
      'A request is stored in one repository only (not copied by a harvest or a nested repository).',
  },
  I2: {
    name: 'legacy-total-counted-once',
    blocking: true,
    description:
      "A legacy session total is stored once (not re-keyed by a slot suffix or createdAt, not copied into another repository) and never beside its session's requests.",
  },
  I3: {
    name: 'rows-match-requests',
    blocking: false,
    description:
      "A session's attributed rows, summed across repositories, hold exactly its requests' tokens.",
  },
  I4: {
    name: 'slot-not-main-checkout',
    blocking: false,
    description:
      "A slot's work dir is not its repository's main checkout (it would swallow the checkout's own usage).",
  },
  I5: {
    name: 'cursor-cache-read-counted-once',
    blocking: false,
    description: "A Cursor row's input does not already include the cache reads stored beside it.",
  },
} as const;

export type UsageInvariantId = keyof typeof USAGE_INVARIANTS;

export interface LedgerObservation extends ObservationFact {
  repositoryId: string;
}

/** A usage row as Mission Control serves it and har-portal receives it. */
export interface LedgerRow {
  repositoryId: string;
  agentTool: string;
  /** `attributed`: projected from requests; `reported`: a provider total without requests; `legacy`: a stored session total. */
  kind: 'attributed' | 'reported' | 'legacy';
  /** The provider session id; for a legacy total, its stored session key. */
  key: string;
  /** Slot of the row; 0 outside slots. */
  slotId: number;
  workDir: string | null;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheCreation: number;
  tokensTotal: number;
  costUsd: number | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

export interface UsageLedger {
  repositories: Array<{ id: string; path: string }>;
  observations: LedgerObservation[];
  rows: LedgerRow[];
}

/** What a sync sends or holds back whole: one provider session (or one legacy row) of one repository. */
export interface UsageUnit {
  repositoryId: string;
  agentTool: string;
  /** Provider session id, or the legacy row's session key. */
  key: string;
}

export interface UsageViolation {
  invariant: UsageInvariantId;
  message: string;
  repositoryIds: string[];
  /** Offending session ids or legacy keys. */
  keys: string[];
  /** Usage counted wrongly. */
  tokens: number;
  costUsd: number;
  /** Units a sync holds back (blocking invariants only). */
  units: UsageUnit[];
}

export interface UsageInvariantReport {
  ok: boolean;
  checked: { repositories: number; observations: number; rows: number };
  summary: Array<{
    invariant: UsageInvariantId;
    name: string;
    blocking: boolean;
    description: string;
    violations: number;
    tokens: number;
    costUsd: number;
  }>;
  violations: UsageViolation[];
  /** Units breaking a blocking invariant: `har control sync` leaves them out of the HQ post. */
  blockedUnits: Array<UsageUnit & { invariants: UsageInvariantId[] }>;
}

// ---------------------------------------------------------------------------
// Adapters

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const date = (value: unknown) => (value instanceof Date ? value : new Date(String(value)));

function counters(row: Record<string, unknown>) {
  return {
    workDir: typeof row.workDir === 'string' && row.workDir ? row.workDir : null,
    tokensInput: num(row.tokensInput),
    tokensOutput: num(row.tokensOutput),
    tokensCacheRead: num(row.tokensCacheRead),
    tokensCacheCreation: num(row.tokensCacheCreation),
    tokensTotal: num(row.tokensTotal),
    costUsd: row.costUsd == null ? null : num(row.costUsd),
    firstSeenAt: date(row.firstSeenAt),
    lastSeenAt: date(row.lastSeenAt),
  };
}

/** Rows of a har-portal `/api/sync` body's `usage[]`. */
export function ledgerRowsFromPortalUsage(
  repositoryId: string,
  rows: Array<Record<string, unknown>>,
): LedgerRow[] {
  return rows.map((row) => {
    const sessionId =
      typeof row.providerSessionId === 'string' && row.providerSessionId
        ? row.providerSessionId
        : null;
    const kind = !sessionId
      ? 'legacy'
      : String(row.sessionKey).endsWith('@reported')
        ? 'reported'
        : 'attributed';
    return {
      repositoryId,
      agentTool: String(row.agentTool),
      kind,
      key: sessionId ?? String(row.sessionKey),
      slotId: num(row.agentId),
      ...counters(row),
    };
  });
}

/** Rows of a Mission Control usage view (`GET /api/repos/:id/usage`): `usage[]` slot and legacy rows, `unassigned[]` the rest. */
export function ledgerRowsFromUsageView(
  repositoryId: string,
  view: { usage?: Array<Record<string, unknown>>; unassigned?: Array<Record<string, unknown>> },
): LedgerRow[] {
  return [
    ...(view.usage ?? []).map((row): LedgerRow => ({
      repositoryId,
      agentTool: String(row.agentTool),
      kind: row.origin === 'legacy' ? 'legacy' : 'attributed',
      key: String(row.sessionKey),
      slotId: num(row.agentId),
      ...counters(row),
    })),
    ...(view.unassigned ?? []).map((row): LedgerRow => ({
      repositoryId,
      agentTool: String(row.agentTool),
      kind: row.itemized === false ? 'reported' : 'attributed',
      key: String(row.sessionId),
      slotId: 0,
      ...counters(row),
    })),
  ];
}

// ---------------------------------------------------------------------------
// Checks

type Draft = Omit<UsageViolation, 'units'> & { units?: UsageUnit[] };

const requestTokens = (o: ObservationFact) =>
  o.tokensInput + o.tokensOutput + o.tokensCacheRead + o.tokensCacheCreation;
const requestCost = (o: ObservationFact) => priceObservation(o).pricedCostUsd ?? 0;
const sum = <T>(items: T[], of: (item: T) => number) =>
  items.reduce((total, item) => total + of(item), 0);
const round = (n: number) => Math.round(n * 1e6) / 1e6;
const sorted = (values: Iterable<string>) => [...new Set(values)].sort();
const trimPath = (p: string | null) => p?.replace(/\/+$/, '') || null;

function groupBy<T>(items: T[], keyOf: (item: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    if (key !== null) groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

/** Copies beyond the first hold the miscounted usage. */
function extraCopies<T>(copies: T[], size: (item: T) => number): T[] {
  return [...copies].sort((a, b) => size(b) - size(a)).slice(1);
}

/** I1 — a request stored in several repositories (a transcript harvest, a nested repository). */
function requestInOneRepository(ledger: UsageLedger): Draft[] {
  const requests = groupBy(
    ledger.observations,
    (o) => `${o.agentTool}\0${o.sessionId}\0${o.observationKey}`,
  );
  const copied = [...requests.values()].filter(
    (copies) => new Set(copies.map((o) => o.repositoryId)).size > 1,
  );
  return [
    ...groupBy(copied, (copies) => `${copies[0].agentTool}\0${copies[0].sessionId}`).values(),
  ].map((sessionCopies) => {
    const { agentTool, sessionId } = sessionCopies[0][0];
    const repositoryIds = sorted(sessionCopies.flat().map((o) => o.repositoryId));
    const extra = sessionCopies.flatMap((copies) => copies.slice(1));
    return {
      invariant: 'I1',
      message: `${agentTool} session ${sessionId}: ${sessionCopies.length} request(s) stored in ${repositoryIds.length} repositories`,
      repositoryIds,
      keys: [sessionId],
      tokens: sum(extra, requestTokens),
      costUsd: round(sum(extra, requestCost)),
      units: repositoryIds.map((repositoryId) => ({ repositoryId, agentTool, key: sessionId })),
    };
  });
}

/**
 * I2 — a legacy total stored twice. Legacy totals are snapshots of one usage
 * stream, which starts once: totals of one tool with the same start are one
 * stream (re-keyed, or copied into another repository). A legacy total of a
 * session that has requests counts it twice too.
 */
function legacyTotalCountedOnce(ledger: UsageLedger): Draft[] {
  const legacy = ledger.rows.filter((r) => r.kind === 'legacy');
  const unit = (r: LedgerRow): UsageUnit => ({
    repositoryId: r.repositoryId,
    agentTool: r.agentTool,
    key: r.key,
  });
  const violation = (rows: LedgerRow[], counted: LedgerRow[], message: string): Draft => ({
    invariant: 'I2',
    message,
    repositoryIds: sorted(rows.map((r) => r.repositoryId)),
    keys: sorted(rows.map((r) => r.key)),
    tokens: sum(counted, (r) => r.tokensTotal),
    costUsd: round(sum(counted, (r) => r.costUsd ?? 0)),
    units: rows.map(unit),
  });
  const streams = [...groupBy(legacy, (r) => `${r.agentTool}\0${r.firstSeenAt.getTime()}`).values()]
    .filter((rows) => rows.length > 1)
    .map((rows) =>
      violation(
        rows,
        extraCopies(rows, (r) => r.tokensTotal),
        `one legacy usage stream (started ${rows[0].firstSeenAt.toISOString()}) stored as ${rows.length} rows`,
      ),
    );
  const observed = new Set(ledger.observations.map((o) => `${o.agentTool}\0${o.sessionId}`));
  const besideRequests = legacy
    .filter((r) => observed.has(`${r.agentTool}\0${r.key}`))
    .map((r) =>
      violation([r], [r], `legacy total ${r.key} is counted beside its session's requests`),
    );
  return [...streams, ...besideRequests];
}

const TOKEN_FIELDS = [
  'tokensInput',
  'tokensOutput',
  'tokensCacheRead',
  'tokensCacheCreation',
] as const;

/** I3 — the projection gains or loses usage: a session's attributed rows against its requests, each counted once. */
function rowsMatchRequests(ledger: UsageLedger): Draft[] {
  const requests = groupBy(ledger.observations, (o) => `${o.agentTool}\0${o.sessionId}`);
  const rows = groupBy(ledger.rows, (r) =>
    r.kind === 'attributed' ? `${r.agentTool}\0${r.key}` : null,
  );
  const out: Draft[] = [];
  for (const session of new Set([...requests.keys(), ...rows.keys()])) {
    const [agentTool, sessionId] = session.split('\0');
    const sessionRows = rows.get(session) ?? [];
    const sessionRequests = requests.get(session) ?? [];
    // Each request once (I1 reports copies), one producer per instant: what the projection counts.
    const counted = dedupeProducers(
      [...groupBy(sessionRequests, (o) => o.observationKey).values()].map((copies) => copies[0]),
    );
    const diff = TOKEN_FIELDS.map((f) => sum(sessionRows, (r) => r[f]) - sum(counted, (o) => o[f]));
    if (diff.every((d) => d === 0)) continue;
    const total = sum(diff, (d) => d);
    out.push({
      invariant: 'I3',
      message:
        `${agentTool} session ${sessionId}: attributed rows ${total >= 0 ? 'gain' : 'lose'} ${Math.abs(total)} tokens against its requests ` +
        `(${TOKEN_FIELDS.filter((_, i) => diff[i] !== 0).join(', ')})`,
      repositoryIds: sorted([...sessionRows, ...sessionRequests].map((x) => x.repositoryId)),
      keys: [sessionId],
      tokens: sum(diff, Math.abs),
      costUsd: round(Math.abs(sum(sessionRows, (r) => r.costUsd ?? 0) - sum(counted, requestCost))),
    });
  }
  return out;
}

/** I4 — a slot whose work dir is the main checkout (it swallows the checkout's own sessions). */
function slotNotMainCheckout(ledger: UsageLedger): Draft[] {
  const mainCheckout = new Map(ledger.repositories.map((r) => [r.id, trimPath(r.path)]));
  const inMain = ledger.rows.filter(
    (r) => r.slotId > 0 && r.workDir && trimPath(r.workDir) === mainCheckout.get(r.repositoryId),
  );
  return [...groupBy(inMain, (r) => `${r.repositoryId}\0${r.slotId}`).values()].map((rows) => ({
    invariant: 'I4',
    message: `slot ${rows[0].slotId} books ${rows.length} row(s) in the main checkout ${mainCheckout.get(rows[0].repositoryId)}`,
    repositoryIds: [rows[0].repositoryId],
    keys: rows.map((r) => r.key),
    tokens: sum(rows, (r) => r.tokensTotal),
    costUsd: round(sum(rows, (r) => r.costUsd ?? 0)),
  }));
}

/**
 * I5 — Cursor reports an input that includes its cache reads; HAR keeps
 * disjoint buckets. A large input made almost entirely of the cache reads
 * stored beside it is the inclusive input, with the reads counted again.
 */
function cursorCacheReadCountedOnce(ledger: UsageLedger): Draft[] {
  return ledger.rows
    .filter(
      (r) =>
        r.agentTool === 'cursor' &&
        r.tokensInput >= 100_000 &&
        r.tokensInput >= r.tokensCacheRead &&
        r.tokensCacheRead >= 0.8 * r.tokensInput,
    )
    .map((r) => ({
      invariant: 'I5',
      message: `cursor row ${r.key}: input ${r.tokensInput} already includes its ${r.tokensCacheRead} cache reads`,
      repositoryIds: [r.repositoryId],
      keys: [r.key],
      tokens: r.tokensCacheRead,
      costUsd: 0,
    }));
}

/** Every invariant over a ledger; `repositoryIds` keeps the violations touching those repositories. */
export function checkUsageInvariants(
  ledger: UsageLedger,
  options: { repositoryIds?: string[] } = {},
): UsageInvariantReport {
  const scope = options.repositoryIds ? new Set(options.repositoryIds) : null;
  const violations: UsageViolation[] = [
    ...requestInOneRepository(ledger),
    ...legacyTotalCountedOnce(ledger),
    ...rowsMatchRequests(ledger),
    ...slotNotMainCheckout(ledger),
    ...cursorCacheReadCountedOnce(ledger),
  ]
    .filter((v) => !scope || v.repositoryIds.some((id) => scope.has(id)))
    .map((v) => ({ ...v, units: v.units ?? [] }));

  const blocked = new Map<string, UsageInvariantReport['blockedUnits'][number]>();
  for (const v of violations) {
    for (const unit of v.units) {
      if (scope && !scope.has(unit.repositoryId)) continue;
      const id = `${unit.repositoryId}\0${usageUnitKey(unit)}`;
      const entry = blocked.get(id) ?? { ...unit, invariants: [] };
      if (!entry.invariants.includes(v.invariant)) entry.invariants.push(v.invariant);
      blocked.set(id, entry);
    }
  }
  return {
    ok: violations.length === 0,
    checked: {
      repositories: ledger.repositories.length,
      observations: ledger.observations.length,
      rows: ledger.rows.length,
    },
    summary: (Object.keys(USAGE_INVARIANTS) as UsageInvariantId[]).map((invariant) => {
      const hits = violations.filter((v) => v.invariant === invariant);
      return {
        invariant,
        ...USAGE_INVARIANTS[invariant],
        violations: hits.length,
        tokens: sum(hits, (v) => v.tokens),
        costUsd: round(sum(hits, (v) => v.costUsd)),
      };
    }),
    violations,
    blockedUnits: [...blocked.values()],
  };
}

/** Key of a sync unit within a repository, as `har control sync` groups its rows. */
export function usageUnitKey(unit: { agentTool: string; key: string }): string {
  return `${unit.agentTool}\0${unit.key}`;
}
