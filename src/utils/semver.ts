/**
 * Compare dotted numeric versions (e.g. 1.8.0 vs 1.0.0).
 * Returns -1 if `a < b`, 0 if equal, 1 if `a > b`.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

// ── Range matching ─────────────────────────────────────────────────────────────
// A small npm-style range matcher, enough for `engines.node`, `.nvmrc` and
// `.node-version` values: `>=`, `>`, `<`, `<=`, `=`, `^`, `~`, `x`/`*`
// wildcards, partial versions (`22`, `22.1`), hyphen ranges (`20 - 22`),
// space-separated AND and `||`. Prerelease/build tags are ignored (installed
// runtimes are releases).

type Triple = [number, number, number];

interface Comparator {
  op: '<' | '<=' | '>' | '>=' | '=';
  version: Triple;
}

/** OR of AND-sets; an empty AND-set matches everything. */
export type ParsedRange = Comparator[][];

interface Partial {
  major: number | null;
  minor: number | null;
  patch: number | null;
}

const PARTIAL_RE = /^v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:[-+].*)?$/;

function parsePartial(input: string): Partial | null {
  const m = input.trim().replace(/^=+/, '').match(PARTIAL_RE);
  if (!m) return null;
  const num = (s: string | undefined): number | null =>
    s === undefined || /^[xX*]$/.test(s) ? null : parseInt(s, 10);
  const major = num(m[1]);
  const minor = major === null ? null : num(m[2]);
  const patch = minor === null ? null : num(m[3]);
  return { major, minor, patch };
}

/** Parse a full or partial version ("v24.14.0", "22") into a triple, or null. */
export function parseVersion(input: string): Triple | null {
  const p = parsePartial(input);
  if (!p || p.major === null) return null;
  return [p.major, p.minor ?? 0, p.patch ?? 0];
}

function cmp(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

function floor(p: Partial): Triple {
  return [p.major ?? 0, p.minor ?? 0, p.patch ?? 0];
}

/** Exclusive upper bound of a partial ("22" → 23.0.0, "22.1" → 22.2.0). */
function ceilingExclusive(p: Partial): Triple | null {
  if (p.major === null) return null;
  if (p.minor === null) return [p.major + 1, 0, 0];
  if (p.patch === null) return [p.major, p.minor + 1, 0];
  return null;
}

function expandComparator(token: string): Comparator[] | null {
  const m = token.match(/^(>=|<=|>|<|=|\^|~>?|)(.*)$/);
  if (!m) return null;
  const op = m[1];
  const p = parsePartial(m[2]);
  if (!p) return null;
  if (p.major === null) {
    // `*`, `x`, `>=*`: anything; `<*` / `>*`: nothing.
    return op === '<' || op === '>' ? [{ op: '<', version: [0, 0, 0] }] : [];
  }
  const lo = floor(p);
  const hiEx = ceilingExclusive(p);
  switch (op) {
    case '':
    case '=':
      return hiEx
        ? [{ op: '>=', version: lo }, { op: '<', version: hiEx }]
        : [{ op: '=', version: lo }];
    case '>=':
      return [{ op: '>=', version: lo }];
    case '>':
      return hiEx ? [{ op: '>=', version: hiEx }] : [{ op: '>', version: lo }];
    case '<':
      return [{ op: '<', version: lo }];
    case '<=':
      return hiEx ? [{ op: '<', version: hiEx }] : [{ op: '<=', version: lo }];
    case '~':
    case '~>': {
      const upper: Triple = p.minor === null ? [lo[0] + 1, 0, 0] : [lo[0], lo[1] + 1, 0];
      return [{ op: '>=', version: lo }, { op: '<', version: upper }];
    }
    case '^': {
      let upper: Triple;
      if (lo[0] > 0 || p.minor === null) upper = [lo[0] + 1, 0, 0];
      else if (lo[1] > 0 || p.patch === null) upper = [0, lo[1] + 1, 0];
      else upper = [0, 0, lo[2] + 1];
      return [{ op: '>=', version: lo }, { op: '<', version: upper }];
    }
    default:
      return null;
  }
}

/** Parse an npm-style range; null when any part is not understood. */
export function parseRange(range: string): ParsedRange | null {
  const sets: ParsedRange = [];
  for (const rawSet of range.split('||')) {
    let set = rawSet.trim().replace(/(>=|<=|>|<|=|\^|~>?)\s+/g, '$1');
    const comparators: Comparator[] = [];
    const hyphen = set.match(/^(\S+)\s+-\s+(\S+)$/);
    if (hyphen) {
      const a = parsePartial(hyphen[1]);
      const b = parsePartial(hyphen[2]);
      if (!a || !b) return null;
      if (a.major !== null) comparators.push({ op: '>=', version: floor(a) });
      if (b.major !== null) {
        const hiEx = ceilingExclusive(b);
        comparators.push(hiEx ? { op: '<', version: hiEx } : { op: '<=', version: floor(b) });
      }
      sets.push(comparators);
      continue;
    }
    if (set === '') set = '*';
    for (const token of set.split(/\s+/)) {
      const expanded = expandComparator(token);
      if (!expanded) return null;
      comparators.push(...expanded);
    }
    sets.push(comparators);
  }
  return sets;
}

function testComparator(v: Triple, c: Comparator): boolean {
  const d = cmp(v, c.version);
  switch (c.op) {
    case '<':
      return d < 0;
    case '<=':
      return d <= 0;
    case '>':
      return d > 0;
    case '>=':
      return d >= 0;
    case '=':
      return d === 0;
  }
}

/** True when `version` satisfies the npm-style `range` (false on unparseable input). */
export function satisfiesRange(version: string, range: string | ParsedRange): boolean {
  const v = parseVersion(version);
  const parsed = typeof range === 'string' ? parseRange(range) : range;
  if (!v || !parsed) return false;
  return parsed.some((set) => set.every((c) => testComparator(v, c)));
}

/** Highest version in `versions` satisfying every range in `ranges`, or null. */
export function maxSatisfyingAll(versions: string[], ranges: string[]): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (!ranges.every((r) => satisfiesRange(version, r))) continue;
    if (best === null || compareSemver(version.replace(/^v/, ''), best.replace(/^v/, '')) > 0) {
      best = version;
    }
  }
  return best;
}
