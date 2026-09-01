import { describe, expect, it } from 'vitest';
import { extractVerification } from './validation-stages';

const step = { name: 'smoke', pass: true, ms: 12 };

describe('extractVerification', () => {
  it('reads the nested data.verification.stages breakdown', () => {
    const result = { status: 'pass', data: { verification: { status: 'pass', agent_id: 1, stages: [step] } } };
    expect(extractVerification(result)?.stages).toEqual([step]);
  });

  it('accepts producers that name the array `steps` and omit status/agent_id', () => {
    const result = { status: 'pass', data: { verification: { full: true, ok: true, steps: [step] } } };
    expect(extractVerification(result)?.stages).toEqual([step]);
  });

  it('falls back to the verify.sh JSON printed on stdout', () => {
    const result = {
      status: 'pass',
      logs: [{ stream: 'stdout', content: JSON.stringify({ status: 'pass', agent_id: 2, stages: [step] }) }],
    };
    expect(extractVerification(result)?.stages).toEqual([step]);
  });

  it('returns null when no per-stage breakdown exists', () => {
    expect(extractVerification({ status: 'pass', logs: [{ stream: 'stdout', content: 'ok' }] })).toBeNull();
    expect(extractVerification(null)).toBeNull();
  });
});
