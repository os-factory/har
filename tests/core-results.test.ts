import {
  extractJsonFromOutput,
  parseVerificationResult,
  slimVerificationResult,
  buildStageResult,
} from '../src/core/results';

describe('parseVerificationResult', () => {
  it('parses JSON emitted by verify.sh', () => {
    const stdout = `progress on stderr\n${JSON.stringify({
      status: 'pass',
      agent_id: 2,
      total_ms: 100,
      stages: [{ name: 'typecheck', pass: true, ms: 50, output: 'ok' }],
    })}\n`;

    const result = parseVerificationResult(stdout);
    expect(result).toEqual({
      status: 'pass',
      agent_id: 2,
      total_ms: 100,
      stages: [{ name: 'typecheck', pass: true, ms: 50, output: 'ok' }],
    });
  });

  it('retains a coverage figure emitted by verify.sh', () => {
    const stdout = `${JSON.stringify({
      status: 'pass',
      agent_id: 1,
      coverage: 87.5,
      stages: [{ name: 'unit-tests', pass: true }],
    })}\n`;

    expect(parseVerificationResult(stdout)?.coverage).toBe(87.5);
  });

  it('returns null for invalid output', () => {
    expect(parseVerificationResult('not json')).toBeNull();
  });
});

describe('slimVerificationResult', () => {
  it('drops output from passing stages and keeps failed-step output', () => {
    expect(
      slimVerificationResult({
        status: 'fail',
        agent_id: 1,
        total_ms: 20,
        stages: [
          { name: 'typecheck', pass: true, ms: 5, output: 'ok' },
          { name: 'unit-tests', pass: false, ms: 15, output: 'FAIL' },
        ],
      }),
    ).toEqual({
      status: 'fail',
      agent_id: 1,
      total_ms: 20,
      stages: [
        { name: 'typecheck', pass: true, ms: 5 },
        { name: 'unit-tests', pass: false, ms: 15, output: 'FAIL' },
      ],
    });
  });

  it('returns null when verification is missing', () => {
    expect(slimVerificationResult(null)).toBeNull();
    expect(slimVerificationResult(undefined)).toBeNull();
  });
});

describe('extractJsonFromOutput', () => {
  it('finds trailing JSON object in mixed output', () => {
    const json = extractJsonFromOutput('logs\n{"status":"pass","agent_id":1,"stages":[]}');
    expect(json).toMatchObject({ status: 'pass', agent_id: 1 });
  });
});

describe('buildStageResult', () => {
  it('marks stage failed when exit code is non-zero', () => {
    const result = buildStageResult({
      stageId: 'verify',
      exitCode: 1,
      stdout: '{"status":"fail","agent_id":1,"stages":[]}',
      stderr: '',
    });
    expect(result.status).toBe('fail');
    expect(result.stageId).toBe('verify');
  });

  it('merges urls from generic stage JSON output', () => {
    const result = buildStageResult({
      stageId: 'custom-smoke',
      kind: 'custom',
      exitCode: 0,
      stdout: '{"status":"pass","urls":[{"url":"http://localhost:3000"}]}',
      stderr: '',
    });
    expect(result.urls).toEqual([{ url: 'http://localhost:3000' }]);
  });
});
