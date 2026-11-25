import { describe, expect, it, vi } from 'vitest';

/**
 * The attempt record API carries the Factory Commits proof of the attempt's verified
 * tree, tied to its verify run, snapshot and commit (the work-unit page and History
 * read the same record).
 */

const REPO = 'repo-1';
const ATTEMPT = '69437791-d4ac-47ab-aa0a-2532e1e57109';
const VALIDATION = '8ec3a247-475c-4f69-b2b3-b991e3897b58';
const VERIFY_RUN = '93892f28-fdf3-4071-a710-dc54e7cd7dc1';
const TREE = '810a0e26b8a45f0aee58fd4437d2e37ad382a019';
const COMMIT = '3835ee6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const DIGEST = 'sha256:6b69ffb1003095b8fef95c554a335d92d9ce0ec2f5989d8b173f2d3586825aa4';
const at = (iso: string) => new Date(iso);

const verificationQueries: unknown[] = [];

vi.mock('@/lib/db', () => ({
  prisma: {
    workAttempt: {
      findUnique: async () => ({
        id: 'wa-1',
        repositoryId: REPO,
        attemptId: ATTEMPT,
        agentId: 1,
        workDir: null,
        worktreePath: '/wt/demo',
        branch: 'main-399b-har-agent-1-bnid',
        baseCommit: null,
        sourceCreatedAt: at('2026-11-25T13:20:00Z'),
        workUnit: null,
        validationBindings: [{ validationId: VALIDATION }],
      }),
      findFirst: async () => null,
    },
    agentSlot: { findFirst: async () => null },
    repository: { findUnique: async () => ({ path: '/home/dev/demo', gitRemote: null }) },
    run: {
      findMany: async () => [
        {
          runId: VERIFY_RUN,
          repositoryId: REPO,
          stageId: 'verify',
          kind: 'verify',
          agentId: 1,
          status: 'pass',
          trigger: 'cli',
          durationMs: 420,
          startedAt: at('2026-11-25T13:25:39.927Z'),
          workDir: null,
          attemptId: ATTEMPT,
          occupancyKey: `attempt::${ATTEMPT}`,
          result: null,
        },
      ],
    },
    changeBatch: {
      findMany: async () => [
        {
          repositoryId: REPO,
          validationId: VALIDATION,
          treeHash: TREE,
          headSha: null,
          branch: 'main-399b-har-agent-1-bnid',
          workDir: null,
          agentId: 1,
          status: 'pass',
          full: true,
          runId: VERIFY_RUN,
          changedFiles: [],
          commitSha: COMMIT,
          committedAt: at('2026-11-25T13:30:00Z'),
          occupancyKey: `attempt::${ATTEMPT}`,
          createdAt: at('2026-11-25T13:25:40Z'),
        },
      ],
    },
    validationCommitBinding: { findMany: async () => [] },
    agentSessionEvent: { findFirst: async () => null },
    verificationRun: {
      findMany: async (query: unknown) => {
        verificationQueries.push(query);
        return [
          {
            runId: VALIDATION,
            traceId: '7eef7f60284e123e6b2edc14bb8eedfb',
            pipelineName: 'har verify --full',
            result: 'success',
            verdict: 'pass',
            treeHash: TREE,
            attestationDigest: DIGEST,
            policyId: null,
            policyDigest: null,
            producerVersion: '2.0.0-next.3',
            startTime: at('2026-11-25T13:25:39.927Z'),
            stages: [
              { name: 'typecheck', result: 'success', addedBy: 'policy' },
              { name: 'unit-tests', result: 'success', addedBy: 'policy' },
            ],
          },
        ];
      },
    },
  },
}));

vi.mock('@/server/usage', () => ({ listSessionUsageForRepo: async () => [], listSessionUsageForSlot: async () => [] }));
vi.mock('@/server/trajectory-ledger', () => ({ listTrajectoryStreams: async () => [] }));
vi.mock('@/server/validation-stages', () => ({ getValidationStages: async () => null, extractVerification: () => null }));

import { GET } from './route';

describe('GET /api/repos/[id]/attempts/[key]', () => {
  it('returns the proofs of the attempt and attaches them to its verify run and commit', async () => {
    const response = await GET(new Request('http://localhost'), {
      params: Promise.resolve({ id: REPO, key: encodeURIComponent(`attempt::${ATTEMPT}`) }),
    });
    expect(response.status).toBe(200);
    const record = await response.json();

    expect(record.proofs).toHaveLength(1);
    expect(record.proofs[0]).toMatchObject({
      factoryRunId: VALIDATION,
      verifyRunId: VERIFY_RUN,
      verdict: 'pass',
      attestationDigest: DIGEST,
      trust: 'self-reported',
      policy: null,
      requiredStages: ['typecheck', 'unit-tests'],
    });

    const commit = record.timeline.find((row: { kind: string }) => row.kind === 'commit');
    expect(commit.proof.attestationDigest).toBe(DIGEST);
    expect(commit.commit.treeHash).toBe(TREE);
    const run = record.timeline.find((row: { kind: string }) => row.kind === 'run');
    expect(run.proof.factoryRunId).toBe(VALIDATION);

    // Joined by the attempt id and by the validation ids its snapshots recorded.
    expect(JSON.stringify(verificationQueries[0])).toContain(ATTEMPT);
    expect(JSON.stringify(verificationQueries[0])).toContain(VALIDATION);
  });
});
