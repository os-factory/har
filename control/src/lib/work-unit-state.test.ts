import { describe, expect, it } from 'vitest';
import { deriveWorkUnitState, formatDurationMs } from './work-unit-state';

describe('deriveWorkUnitState', () => {
  it('honours explicit decisions first', () => {
    expect(deriveWorkUnitState({ decision: 'completed', hasActiveSlot: true, hasFullProof: false })).toBe('completed');
    expect(deriveWorkUnitState({ decision: 'abandoned', hasActiveSlot: false, hasFullProof: true })).toBe('abandoned');
  });
  it('derives active, verified, failed, pending from evidence', () => {
    expect(deriveWorkUnitState({ hasActiveSlot: true, hasFullProof: false })).toBe('active');
    expect(deriveWorkUnitState({ hasActiveSlot: false, hasFullProof: true })).toBe('verified');
    expect(deriveWorkUnitState({ hasActiveSlot: false, hasFullProof: false, latestRunStatus: 'fail' })).toBe('failed');
    expect(deriveWorkUnitState({ hasActiveSlot: false, hasFullProof: false, latestRunStatus: 'pass' })).toBe('pending');
  });
});

describe('formatDurationMs', () => {
  it('formats in human units', () => {
    expect(formatDurationMs(0)).toBe('—');
    expect(formatDurationMs(640)).toBe('640 ms');
    expect(formatDurationMs(40738)).toBe('41s');
    expect(formatDurationMs(303743)).toBe('5m 4s');
    expect(formatDurationMs(2 * 3600_000 + 5 * 60_000)).toBe('2h 5m');
  });
});
