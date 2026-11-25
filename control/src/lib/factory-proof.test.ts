import { describe, expect, it } from 'vitest';
import {
  headlineProof,
  isAttestedProof,
  proofForTree,
  proofForVerifyRun,
  shortDigest,
  shortTraceId,
  toFactoryProof,
  type FactoryProofSource,
} from './factory-proof';
import { attachProofs, buildTimelineRows } from './slot-timeline';
import { proofVerifyCommand } from './slot-commands';

const TREE = '810a0e26b8a45f0aee58fd4437d2e37ad382a019';
const DIGEST = 'sha256:6b69ffb1003095b8fef95c554a335d92d9ce0ec2f5989d8b173f2d3586825aa4';

/** Shaped like the sandbox DEMO-1 verification: Factory run 8ec3a247, verify run 93892f28. */
function source(overrides: Partial<FactoryProofSource> = {}): FactoryProofSource {
  return {
    runId: '8ec3a247-475c-4f69-b2b3-b991e3897b58',
    traceId: '7eef7f60284e123e6b2edc14bb8eedfb',
    pipelineName: 'har verify --full',
    result: 'success',
    verdict: 'pass',
    treeHash: TREE,
    attestationDigest: DIGEST,
    policyId: null,
    policyDigest: null,
    producerVersion: '2.0.0-next.3',
    startTime: new Date('2026-11-25T13:25:39.927Z'),
    stages: [
      { name: 'typecheck', result: 'success', addedBy: 'policy' },
      { name: 'unit-tests', result: 'success', addedBy: 'policy' },
      { name: 'smoke', result: 'success', addedBy: 'agent' },
      { name: 'lint', result: 'success', addedBy: null },
    ],
    ...overrides,
  };
}

const byValidation = new Map([['8ec3a247-475c-4f69-b2b3-b991e3897b58', '93892f28-fdf3-4071-a710-dc54e7cd7dc1']]);

describe('toFactoryProof', () => {
  it('keeps the Factory run (proof) and the verify run apart, joined through the snapshot', () => {
    const proof = toFactoryProof(source(), byValidation);
    expect(proof.factoryRunId).toBe('8ec3a247-475c-4f69-b2b3-b991e3897b58');
    expect(proof.verifyRunId).toBe('93892f28-fdf3-4071-a710-dc54e7cd7dc1');
    expect(proof.trust).toBe('self-reported');
    expect(proof.startTime).toBe('2026-11-25T13:25:39.927Z');
    expect(isAttestedProof(proof)).toBe(true);
  });

  it('lists only stages the trace marks as added by the policy as required', () => {
    expect(toFactoryProof(source(), byValidation).requiredStages).toEqual(['typecheck', 'unit-tests']);
  });

  it('shows a policy only when the run span carried one, never inferred from the pipeline name', () => {
    expect(toFactoryProof(source(), byValidation).policy).toBeNull();
    expect(toFactoryProof(source({ policyId: 'har-verify-full', policyDigest: 'sha256:abc' }), byValidation).policy).toEqual({
      id: 'har-verify-full',
      digest: 'sha256:abc',
    });
  });

  it('falls back to the run id itself when a trace predates validation ids', () => {
    const proof = toFactoryProof(source({ runId: 'run-7' }), new Map(), new Set(['run-7']));
    expect(proof.verifyRunId).toBe('run-7');
    expect(toFactoryProof(source({ runId: 'run-8' }), new Map()).verifyRunId).toBeNull();
  });

  it('is not attested without a digest or a verdict', () => {
    expect(isAttestedProof(toFactoryProof(source({ attestationDigest: null }), byValidation))).toBe(false);
    expect(isAttestedProof(toFactoryProof(source({ verdict: null }), byValidation))).toBe(false);
  });
});

describe('proof lookups', () => {
  const attested = toFactoryProof(source(), byValidation);
  const bare = toFactoryProof(source({ runId: 'other', attestationDigest: null, startTime: new Date('2026-11-25T14:00:00Z') }), new Map());

  it('prefers the attested proof of a tree', () => {
    expect(proofForTree([bare, attested], TREE)).toBe(attested);
    expect(proofForTree([bare, attested], 'f'.repeat(40))).toBeNull();
    expect(headlineProof([bare, attested])).toBe(attested);
    expect(headlineProof([bare])).toBe(bare);
    expect(headlineProof([])).toBeNull();
  });

  it('finds a verify run proof by Mission Control run id', () => {
    expect(proofForVerifyRun([attested], '93892f28-fdf3-4071-a710-dc54e7cd7dc1')).toBe(attested);
    expect(proofForVerifyRun([attested], null)).toBeNull();
  });

  it('shortens digests and trace ids for display', () => {
    expect(shortDigest(DIGEST)).toBe('sha256:6b69ffb1…');
    expect(shortDigest('abcd')).toBe('abcd');
    expect(shortTraceId('7eef7f60284e123e6b2edc14bb8eedfb')).toBe('7eef7f60…');
  });
});

describe('attachProofs', () => {
  it('puts the proof on the verify run, the snapshot and the commit of the verified tree', () => {
    const proof = toFactoryProof(source(), byValidation);
    const rows = attachProofs(
      buildTimelineRows({
        runs: [
          {
            runId: '93892f28-fdf3-4071-a710-dc54e7cd7dc1',
            stageId: 'verify',
            kind: 'verify',
            status: 'pass',
            trigger: 'cli',
            durationMs: 420,
            agentId: 1,
            startedAt: new Date('2026-11-25T13:25:39.927Z'),
            stages: [],
          },
          {
            runId: 'launch-1',
            stageId: 'launch',
            kind: 'launch',
            status: 'pass',
            trigger: 'cli',
            durationMs: 10,
            agentId: 1,
            startedAt: new Date('2026-11-25T13:20:00Z'),
            stages: [],
          },
        ],
        snapshots: [
          {
            validationId: '8ec3a247-475c-4f69-b2b3-b991e3897b58',
            treeHash: TREE,
            branch: 'main-399b-har-agent-1-bnid',
            agentId: 1,
            status: 'pass',
            full: true,
            runId: '93892f28-fdf3-4071-a710-dc54e7cd7dc1',
            changedFiles: [],
            commitSha: '3835ee6f00000000000000000000000000000000',
            committedAt: new Date('2026-11-25T13:30:00Z'),
            createdAt: new Date('2026-11-25T13:25:40Z'),
          },
        ],
      }),
      [proof],
    );
    const byKind = (kind: string) => rows.filter((row) => row.kind === kind);
    expect(byKind('run').find((row) => row.run?.stageId === 'verify')?.proof).toBe(proof);
    expect(byKind('run').find((row) => row.run?.stageId === 'launch')?.proof).toBeUndefined();
    expect(byKind('snapshot')[0].proof).toBe(proof);
    const commit = byKind('commit')[0];
    expect(commit.proof).toBe(proof);
    expect(commit.detail).toContain('proof attested');
    // The handoff still finds the verified-tree commit.
    expect(commit.status).toBe('Verified tree');
  });

  it('leaves rows untouched without proofs', () => {
    const rows = buildTimelineRows({});
    expect(attachProofs(rows, [])).toBe(rows);
  });
});

describe('proofVerifyCommand', () => {
  it('prefills --repo like the other copy commands', () => {
    expect(proofVerifyCommand('/home/dev/demo', '3835ee6')).toBe('har proof verify 3835ee6 --repo /home/dev/demo');
    expect(proofVerifyCommand('/home/dev/my repo', 'abc')).toBe("har proof verify abc --repo '/home/dev/my repo'");
    expect(proofVerifyCommand(null, 'abc')).toBe('har proof verify abc');
  });
});
