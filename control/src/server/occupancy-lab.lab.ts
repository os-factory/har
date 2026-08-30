import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '@/lib/db';
import { registerRepository, syncSlots } from '@/server/repositories';
import { resolveSessionContext } from '@/server/otel-ingest';
import { appendTrajectoryRecord, listTrajectoryStreams } from '@/server/trajectory-ledger';
import { listSessionUsageForSlot, upsertSessionUsage } from '@/server/usage';

/**
 * Occupancy lab — station S3 of the occupancy-identity line (#316).
 *
 * Unlike the S0–S2 unit stations, nothing here is mocked: a real HAR CLI drives
 * a real launch → complete → launch cycle on a scratch git repository, and the
 * resulting status feeds Mission Control's real sync and ingest code against a
 * real SQLite database.
 *
 * It runs inside the lab container so HOME is isolated. On a developer laptop,
 * Claude Code transcripts under ~/.claude/projects/<encoded-cwd> outlive the
 * worktree and the harvest can re-attach them to the next occupancy of the same
 * slot — a green run there can just mean the machine was clean.
 *
 * Excluded from `npm test` by vitest.lab.config.ts. Run it with:
 *   har line gate S3 --line occupancy-identity
 */

const HAR_CLI = process.env.LAB_HAR_CLI ?? path.resolve(__dirname, '../../../dist/index.js');
const ALLOW_HOST_HOME = process.env.OCCUPANCY_LAB_ALLOW_HOST_HOME === '1';

function run(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd,
    env: process.env,
  });
}

function makeFixtureRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'occupancy-lab-repo-'));
  writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'occupancy-lab-fixture', version: '1.0.0' }, null, 2)}\n`,
  );
  run('git', ['init', '-q', '-b', 'main'], dir);
  run('git', ['add', '-A'], dir);
  run('git', ['commit', '-q', '-m', 'chore: fixture'], dir);
  run('node', [HAR_CLI, 'env', 'init', '--profile', 'cli', '--yes', '--repo', dir]);
  run('git', ['add', '-A'], dir);
  run('git', ['commit', '-q', '-m', 'chore: harness'], dir);
  return dir;
}

type SlotSnapshot = {
  agentId: number;
  active: boolean;
  branch?: string;
  workDir?: string;
  worktreePath?: string;
  attemptId?: string;
  sessionCreatedAt?: string;
  harnessUsage: string;
};

function statusPayload(repoDir: string): { slots: SlotSnapshot[]; generatedAt: string } {
  const raw = run('node', [HAR_CLI, 'env', 'status', '--json', '--repo', repoDir]);
  const parsed = JSON.parse(raw) as { slots?: SlotSnapshot[] };
  return { slots: parsed.slots ?? [], generatedAt: new Date().toISOString() };
}

async function slotRow(repositoryId: string) {
  return prisma.agentSlot.findUnique({
    where: { repositoryId_slotId: { repositoryId, slotId: 1 } },
  });
}

describe('S3 — occupancy identity survives a real complete → launch cycle', () => {
  let repositoryId: string;
  let repoDir: string;
  const occupancyA = { key: '', branch: '', sessionKey: '' };
  const occupancyB = { key: '', branch: '' };

  beforeAll(async () => {
    // The sandbox is the point of this station.
    if (!ALLOW_HOST_HOME) {
      expect(homedir()).toBe('/lab/home');
      expect(existsSync(path.join(homedir(), '.claude', 'projects'))).toBe(false);
    }
    expect(existsSync(HAR_CLI)).toBe(true);

    repoDir = makeFixtureRepo();
    const registered = await registerRepository({ path: repoDir, name: 'occupancy-lab-fixture' });
    repositoryId = registered.id;

    // ── Occupancy A ────────────────────────────────────────────────────────
    run('node', [HAR_CLI, 'env', 'launch', '1', '--repo', repoDir]);
    await syncSlots(repositoryId, statusPayload(repoDir));

    const a = await slotRow(repositoryId);
    occupancyA.key = a?.occupancyKey ?? '';
    occupancyA.branch = a?.branch ?? '';
    occupancyA.sessionKey = occupancyA.branch;

    // An agent worked in A: a purpose, a trajectory stream, and usage.
    await prisma.agentSlot.update({
      where: { repositoryId_slotId: { repositoryId, slotId: 1 } },
      data: { purpose: 'occupancy A — the previous task' },
    });
    await appendTrajectoryRecord(repositoryId, {
      version: 1,
      source: 'otel',
      sourceEventId: 'lab-a-1',
      contentKey: 'prompt',
      sessionKey: occupancyA.sessionKey,
      agentId: 1,
      agentTool: 'claude_code',
      eventType: 'user_prompt',
      sequence: 1,
      timestamp: new Date().toISOString(),
      payload: { text: 'occupancy A prompt' },
      contentKind: 'text',
      contentDisclosure: 'full',
      occupancyKey: occupancyA.key,
    } as never);
    await upsertSessionUsage(repositoryId, {
      sessionKey: occupancyA.sessionKey,
      agentId: 1,
      agentTool: 'claude_code',
      tokensInput: 10,
      tokensOutput: 5,
      tokensCacheRead: 0,
      tokensCacheCreation: 0,
      tokensTotal: 15,
      sources: [],
      harvestVersion: 2,
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      occupancyKey: occupancyA.key,
    } as never);

    // ── Free the workstation, then take it again for different work ────────
    run('node', [HAR_CLI, 'env', 'complete', '1', '--skip-verify', '--repo', repoDir]);
    await syncSlots(repositoryId, statusPayload(repoDir));

    run('node', [HAR_CLI, 'env', 'launch', '1', '--repo', repoDir]);
    await syncSlots(repositoryId, statusPayload(repoDir));

    const b = await slotRow(repositoryId);
    occupancyB.key = b?.occupancyKey ?? '';
    occupancyB.branch = b?.branch ?? '';
  }, 300_000);

  it('mints a new occupancy for the reused slot number', () => {
    expect(occupancyA.key).toBeTruthy();
    expect(occupancyB.key).toBeTruthy();
    expect(occupancyB.key).not.toBe(occupancyA.key);
    expect(occupancyB.branch).not.toBe(occupancyA.branch);
  });

  it('does not carry occupancy A\'s purpose into occupancy B', async () => {
    const b = await slotRow(repositoryId);
    expect(b?.purpose).toBeNull();
  });

  it('lists none of occupancy A\'s trajectory or usage under occupancy B', async () => {
    const streams = await listTrajectoryStreams(repositoryId, 1, occupancyB.key);
    const usage = await listSessionUsageForSlot(repositoryId, 1, occupancyB.key);

    expect(streams).toEqual([]);
    expect(usage).toEqual([]);

    // …and occupancy A really did have something to leak.
    const aStreams = await listTrajectoryStreams(repositoryId, 1, occupancyA.key);
    const aUsage = await listSessionUsageForSlot(repositoryId, 1, occupancyA.key);
    expect(aStreams.length).toBeGreaterThan(0);
    expect(aUsage.length).toBeGreaterThan(0);
  });

  it('refuses a stale har.session_key once the worktree changed', async () => {
    const b = await slotRow(repositoryId);
    const { context } = await resolveSessionContext(
      { 'har.session_key': occupancyA.sessionKey },
      {
        'gen_ai.client.workspace': b?.workDir ?? '',
        'gen_ai.agent.name': 'claude_code',
      },
    );

    expect(context?.sessionKey).toBe(occupancyB.branch);
    expect(context?.sessionKey).not.toBe(occupancyA.sessionKey);
    expect(context?.occupancyKey).toBe(occupancyB.key);
  });

  it('keeps the same occupancy across an idempotent re-sync', async () => {
    await syncSlots(repositoryId, statusPayload(repoDir));
    const again = await slotRow(repositoryId);
    expect(again?.occupancyKey).toBe(occupancyB.key);
  });

  afterAll(() => {
    if (process.env.OCCUPANCY_LAB_KEEP === '1' || !repoDir) return;
    // Free the slot before the checkout disappears, then drop the scratch repo.
    try {
      run('node', [HAR_CLI, 'env', 'teardown', '1', '--repo', repoDir]);
    } catch {
      /* the lab may have failed before launching */
    }
    rmSync(repoDir, { recursive: true, force: true });
  });
});
