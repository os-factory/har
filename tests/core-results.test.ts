import {
  extractJsonFromOutput,
  parseVerificationResult,
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

  it('returns null for invalid output', () => {
    expect(parseVerificationResult('not json')).toBeNull();
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
