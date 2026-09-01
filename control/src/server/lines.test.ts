import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const repositoryFindUnique = vi.fn();
const agentSlotFindMany = vi.fn();
const runFindMany = vi.fn();

vi.mock('@/lib/db', () => ({
  prisma: {
    repository: { findUnique: (...a: unknown[]) => repositoryFindUnique(...a) },
    agentSlot: { findMany: (...a: unknown[]) => agentSlotFindMany(...a) },
    run: { findMany: (...a: unknown[]) => runFindMany(...a) },
  },
}));

import { listLineBoards, repositoryHasHarness } from './lines';

let repoPath: string;

/** A repo with a harness and one installed two-station line. */
function scaffoldRepo(options: { verificationStages?: string[]; installLine?: boolean } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'line-board-'));
  mkdirSync(path.join(dir, '.har', 'lines', 'demo-line'), { recursive: true });

  writeFileSync(
    path.join(dir, '.har', 'stages.json'),
    JSON.stringify({
      version: '1',
      verificationStages: options.verificationStages ?? ['typecheck', 'unit-tests'],
      stages: [
        { id: 'typecheck', kind: 'test' },
        { id: 'unit-tests', kind: 'test' },
        { id: 'demo-s1', kind: 'test' },
        { id: 'demo-s2', kind: 'test' },
      ],
    }),
  );

  if (options.installLine !== false) {
    writeFileSync(
      path.join(dir, '.har', 'lines.json'),
      JSON.stringify({
        version: '1',
        lines: [
          {
            id: 'demo-line',
            source: 'git',
            spec: 'github:acme/demo-line',
            stageIds: ['demo-s1', 'demo-s2'],
            programPath: '.har/lines/demo-line/line.json',
            installedAt: '2026-08-01T00:00:00.000Z',
          },
        ],
      }),
    );
    writeFileSync(
      path.join(dir, '.har', 'lines', 'demo-line', 'line.json'),
      JSON.stringify({
        contractVersion: 1,
        id: 'demo-line',
        title: 'Demo line',
        description: 'Two stations and a growing gate.',
        skills: [{ id: 'factory-line', role: 'orchestrator' }],
        mcp: [{ name: 'github', required: false }],
        plugins: [],
        stations: [
          { id: 'S1', title: 'First', work: { source: 'github', ids: ['42'] } },
          { id: 'S2', title: 'Second' },
        ],
        gate: {
          cumulative: true,
          optInEnv: null,
          stages: [
            { id: 'demo-s1', fromStation: 'S1', tier: 'full' },
            { id: 'demo-s2', fromStation: 'S2', tier: 'full' },
          ],
        },
        extraStages: [],
        handoff: { autonomousShip: false },
        prototypeNotes: [],
      }),
    );
  }
  return dir;
}

beforeEach(() => {
  repositoryFindUnique.mockReset();
  agentSlotFindMany.mockReset();
  runFindMany.mockReset();
  agentSlotFindMany.mockResolvedValue([]);
  runFindMany.mockResolvedValue([]);
});

afterEach(() => {
  if (repoPath) rmSync(repoPath, { recursive: true, force: true });
});

describe('factory line board', () => {
  it('reads stations and the cumulative gate from the installed bundle', async () => {
    repoPath = scaffoldRepo();
    repositoryFindUnique.mockResolvedValue({ path: repoPath });

    const [board] = await listLineBoards('repo-1');

    expect(board.id).toBe('demo-line');
    expect(board.source).toBe('git');
    // The ratchet: S2 requires S1's stage too.
    expect(board.stations[0].requiredStageIds).toEqual(['demo-s1']);
    expect(board.stations[1].requiredStageIds).toEqual(['demo-s1', 'demo-s2']);
    expect(board.nextStationId).toBe('S1');
    expect(board.currentStationId).toBeNull();
  });

  it('derives station greenness from synced run records', async () => {
    repoPath = scaffoldRepo();
    repositoryFindUnique.mockResolvedValue({ path: repoPath });
    runFindMany.mockResolvedValue([
      {
        stageId: 'demo-s1',
        status: 'pass',
        startedAt: new Date('2026-08-02T10:00:00Z'),
        durationMs: 1200,
        agentId: 1,
      },
    ]);

    const [board] = await listLineBoards('repo-1');

    expect(board.stations[0].green).toBe(true);
    expect(board.stations[1].green).toBe(false);
    expect(board.stations[1].neverRunStageIds).toEqual(['demo-s2']);
    expect(board.currentStationId).toBe('S1');
    expect(board.nextStationId).toBe('S2');
    expect(board.latestGateRuns).toHaveLength(1);
  });

  it('reports no verify leak when line stages stay off the verify plan', async () => {
    repoPath = scaffoldRepo();
    repositoryFindUnique.mockResolvedValue({ path: repoPath });

    const [board] = await listLineBoards('repo-1');

    expect(board.registeredStageIds).toEqual(['demo-s1', 'demo-s2']);
    expect(board.verifyLeaks).toEqual([]);
  });

  it('flags a line stage that leaked into verificationStages', async () => {
    repoPath = scaffoldRepo({ verificationStages: ['typecheck', 'demo-s1'] });
    repositoryFindUnique.mockResolvedValue({ path: repoPath });

    const [board] = await listLineBoards('repo-1');

    expect(board.verifyLeaks).toEqual(['demo-s1']);
  });

  it('marks a gate stage the harness never registered', async () => {
    repoPath = scaffoldRepo();
    // Drop demo-s2 from the registry: the program still tags it.
    writeFileSync(
      path.join(repoPath, '.har', 'stages.json'),
      JSON.stringify({
        version: '1',
        verificationStages: ['typecheck'],
        stages: [{ id: 'typecheck', kind: 'test' }, { id: 'demo-s1', kind: 'test' }],
      }),
    );
    repositoryFindUnique.mockResolvedValue({ path: repoPath });

    const [board] = await listLineBoards('repo-1');

    expect(board.stations[1].missingStageIds).toEqual(['demo-s2']);
    expect(board.stations[1].green).toBe(false);
  });

  it('returns an empty board for a harness with no line bundle', async () => {
    repoPath = scaffoldRepo({ installLine: false });
    repositoryFindUnique.mockResolvedValue({ path: repoPath });

    await expect(listLineBoards('repo-1')).resolves.toEqual([]);
    await expect(repositoryHasHarness('repo-1')).resolves.toBe(true);
  });

  it('lists active slots as workstations in use', async () => {
    repoPath = scaffoldRepo();
    repositoryFindUnique.mockResolvedValue({ path: repoPath });
    agentSlotFindMany.mockResolvedValue([
      { slotId: 2, branch: 'feat/x', purpose: 'S1 work', workUnitId: '42', workDir: '/w/x' },
    ]);

    const [board] = await listLineBoards('repo-1');

    expect(board.slotsInFlight).toEqual([
      { slotId: 2, branch: 'feat/x', purpose: 'S1 work', workUnitId: '42', workDir: '/w/x' },
    ]);
  });

  it('never claims a line ships on its own', async () => {
    repoPath = scaffoldRepo();
    repositoryFindUnique.mockResolvedValue({ path: repoPath });

    const [board] = await listLineBoards('repo-1');

    expect(board.handoffAutonomousShip).toBe(false);
  });
});
