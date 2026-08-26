import {
  PRE_DEDUPE_HARVEST_VERSION,
  USAGE_HARVEST_VERSION,
  AgentSessionUsageSchema,
  harvestSupersedes,
  isPreDedupeUsage,
  mergedHarvestVersion,
  usageHarvestVersion,
} from '../src/harness/schema';

const baseRow = {
  sessionKey: 'branch:1',
  agentId: 1,
  agentTool: 'claude_code',
  firstSeenAt: '2026-07-29T00:00:00.000Z',
  lastSeenAt: '2026-07-29T00:00:00.000Z',
};

describe('harvestVersion on AgentSessionUsageSchema', () => {
  it('defaults a row with no version to the pre-dedupe generation', () => {
    expect(AgentSessionUsageSchema.parse(baseRow).harvestVersion).toBe(
      PRE_DEDUPE_HARVEST_VERSION,
    );
  });

  it('retains a stamped version (does not strip it)', () => {
    const parsed = AgentSessionUsageSchema.parse({
      ...baseRow,
      harvestVersion: USAGE_HARVEST_VERSION,
    });
    expect(parsed.harvestVersion).toBe(USAGE_HARVEST_VERSION);
  });
});

describe('usageHarvestVersion', () => {
  it('treats missing, null and junk versions as pre-dedupe', () => {
    expect(usageHarvestVersion(undefined)).toBe(0);
    expect(usageHarvestVersion({ harvestVersion: null })).toBe(0);
    expect(usageHarvestVersion({ harvestVersion: Number.NaN })).toBe(0);
    expect(usageHarvestVersion({ harvestVersion: -3 })).toBe(0);
  });
});

describe('harvestSupersedes', () => {
  it('lets a newer harvest replace an older one', () => {
    expect(
      harvestSupersedes(
        { sources: ['harvest'], harvestVersion: 0 },
        { sources: ['harvest'], harvestVersion: 1 },
      ),
    ).toBe(true);
  });

  it('refuses the same version — a partial re-read is not authoritative', () => {
    expect(
      harvestSupersedes(
        { sources: ['harvest'], harvestVersion: 1 },
        { sources: ['harvest'], harvestVersion: 1 },
      ),
    ).toBe(false);
  });

  it('refuses an older harvest arriving after a newer one', () => {
    expect(
      harvestSupersedes(
        { sources: ['harvest'], harvestVersion: 1 },
        { sources: ['harvest'], harvestVersion: 0 },
      ),
    ).toBe(false);
  });

  it('never replaces a row OTLP contributed to (batches accumulate in place)', () => {
    expect(
      harvestSupersedes(
        { sources: ['harvest', 'otel'], harvestVersion: 0 },
        { sources: ['harvest'], harvestVersion: 1 },
      ),
    ).toBe(false);
    expect(
      harvestSupersedes(
        { sources: ['harvest'], harvestVersion: 0 },
        { sources: ['otel'], harvestVersion: 1 },
      ),
    ).toBe(false);
  });

  it('is false when either side is absent', () => {
    expect(harvestSupersedes(null, { sources: ['harvest'], harvestVersion: 1 })).toBe(false);
    expect(harvestSupersedes({ sources: ['harvest'], harvestVersion: 0 }, null)).toBe(false);
  });
});

describe('mergedHarvestVersion', () => {
  it('keeps the oldest harvest generation of a blended row', () => {
    expect(
      mergedHarvestVersion(
        { sources: ['harvest'], harvestVersion: 1 },
        { sources: ['harvest'], harvestVersion: 0 },
      ),
    ).toBe(0);
  });

  it('ignores a side that contributed no harvest', () => {
    expect(
      mergedHarvestVersion(
        { sources: ['otel'], harvestVersion: 0 },
        { sources: ['harvest'], harvestVersion: 1 },
      ),
    ).toBe(1);
    expect(
      mergedHarvestVersion(
        { sources: ['harvest'], harvestVersion: 1 },
        { sources: ['otel'], harvestVersion: 0 },
      ),
    ).toBe(1);
  });
});

describe('isPreDedupeUsage', () => {
  it('flags a harvested row from before the fix', () => {
    expect(isPreDedupeUsage({ sources: ['harvest'], harvestVersion: 0 })).toBe(true);
  });

  it('does not flag a current harvest', () => {
    expect(isPreDedupeUsage({ sources: ['harvest'], harvestVersion: USAGE_HARVEST_VERSION })).toBe(
      false,
    );
  });

  it('does not flag a pure OTLP row — it was never affected', () => {
    expect(isPreDedupeUsage({ sources: ['otel'], harvestVersion: 0 })).toBe(false);
  });
});
