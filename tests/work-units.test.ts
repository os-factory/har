import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  addWorkUnitLinks,
  bindValidationToAttempt,
  createWorkAttempt,
  decideWorkUnitOutcome,
  findWorkUnit,
  listValidationBindings,
  listWorkAttempts,
  listWorkUnits,
  parseWorkLinkSpec,
  upsertWorkUnit,
} from '../src/core/work-units';
import type { ValidationRecord } from '../src/harness/schema';

describe('durable work identity', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-work-units-'));
    fs.mkdirSync(path.join(repo, '.har'), { recursive: true });
  });

  afterEach(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('persists metadata and immutable attempt identity', () => {
    upsertWorkUnit(repo, {
      workUnitId: 'har-123',
      source: 'github',
      sourceUrl: 'https://github.com/os-factory/har/issues/123',
      title: 'Factory control plane',
    });
    createWorkAttempt(repo, {
      attemptId: '11111111-1111-4111-8111-111111111111',
      workUnitId: 'har-123',
      agentId: 2,
      branch: 'factory-attempt',
    });

    expect(listWorkUnits(repo)).toEqual([
      expect.objectContaining({
        workUnitId: 'har-123',
        source: 'github',
      }),
    ]);
    expect(listWorkAttempts(repo)).toEqual([
      expect.objectContaining({
        attemptId: '11111111-1111-4111-8111-111111111111',
        branch: 'factory-attempt',
      }),
    ]);
  });

  it('links reusable tree proof through per-attempt bindings', () => {
    const validation: ValidationRecord = {
      validationId: '22222222-2222-4222-8222-222222222222',
      treeHash: 'a'.repeat(40),
      workDir: repo,
      harnessRoot: repo,
      status: 'pass',
      full: true,
      changedFiles: [],
      createdAt: '2026-07-23T20:00:00.000Z',
      updatedAt: '2026-07-23T20:00:00.000Z',
    };
    for (const [workUnitId, attemptId] of [
      ['ISSUE-1', '33333333-3333-4333-8333-333333333333'],
      ['ISSUE-2', '44444444-4444-4444-8444-444444444444'],
    ] as const) {
      upsertWorkUnit(repo, { workUnitId });
      createWorkAttempt(repo, { attemptId, workUnitId, agentId: 1 });
      bindValidationToAttempt(repo, { workUnitId, attemptId, validation });
    }

    expect(listValidationBindings(repo)).toHaveLength(2);
    expect(new Set(listValidationBindings(repo).map((row) => row.validationId))).toEqual(
      new Set([validation.validationId]),
    );
  });

  it('requires completion to reference exact-tree proof', () => {
    upsertWorkUnit(repo, { workUnitId: 'ISSUE-9' });

    expect(() =>
      decideWorkUnitOutcome(repo, 'ISSUE-9', {
        decision: 'completed',
        decidedAt: new Date().toISOString(),
      }),
    ).toThrow('completed work must reference');
  });

  it('merges append-only related links and dedupes by url', () => {
    upsertWorkUnit(repo, {
      workUnitId: 'har-217',
      source: 'jira',
      sourceUrl: 'https://company.atlassian.net/browse/HAR-217',
      relatedLinks: [
        { source: 'github', url: 'https://github.com/os-factory/har/issues/217' },
      ],
    });
    addWorkUnitLinks(repo, 'har-217', [
      { source: 'github', url: 'https://github.com/os-factory/har/pull/999', label: 'PR #999' },
      { source: 'github', url: 'https://github.com/os-factory/har/pull/999' },
    ]);

    expect(findWorkUnit(repo, 'har-217')).toEqual(
      expect.objectContaining({
        relatedLinks: [
          { source: 'github', url: 'https://github.com/os-factory/har/issues/217' },
          {
            source: 'github',
            url: 'https://github.com/os-factory/har/pull/999',
            label: 'PR #999',
          },
        ],
      }),
    );
  });

  it('parses CLI work link specs', () => {
    expect(parseWorkLinkSpec('github|https://github.com/org/repo/pull/1|PR #1')).toEqual({
      source: 'github',
      url: 'https://github.com/org/repo/pull/1',
      label: 'PR #1',
    });
  });
});
