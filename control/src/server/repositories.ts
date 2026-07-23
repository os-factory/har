import * as path from 'path';
import {
  AgentSlotStatusSchema,
  RegisterRepoInputSchema,
  RunRecordSchema,
  SyncRunsInputSchema,
  SyncSlotsInputSchema,
} from '@har/schemas';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { canonicalizeControlRepoPath } from '@/server/git-repo-path';
import { buildAgentSlotSyncFields } from '@/server/slot-sync-fields';

function toJson(value: unknown) {
  return JSON.parse(JSON.stringify(value)) as object;
}

export async function registerRepository(input: unknown) {
  const data = RegisterRepoInputSchema.parse(input);
  const requested = path.resolve(data.path);
  const repoPath = canonicalizeControlRepoPath(requested);

  const repo = await prisma.repository.upsert({
    where: { path: repoPath },
    create: {
      path: repoPath,
      gitRemote: data.gitRemote,
      manifest: data.manifest ? toJson(data.manifest) : undefined,
      stagesRegistry: data.stagesRegistry ? toJson(data.stagesRegistry) : undefined,
      lastSyncAt: new Date(),
    },
    update: {
      gitRemote: data.gitRemote,
      manifest: data.manifest ? toJson(data.manifest) : undefined,
      stagesRegistry: data.stagesRegistry ? toJson(data.stagesRegistry) : undefined,
      lastSyncAt: new Date(),
    },
  });

  // Drop a prior row that registered the linked worktree path as its own repo.
  if (requested !== repoPath) {
    await prisma.repository.deleteMany({ where: { path: requested } });
  }

  return repo;
}

/** Remove linked-worktree rows when the main checkout is already registered. */
async function pruneWorktreeRepositoryDuplicates<
  T extends { id: string; path: string },
>(repos: T[]): Promise<T[]> {
  const paths = new Set(repos.map((repo) => repo.path));
  const duplicateIds: string[] = [];

  for (const repo of repos) {
    const canonical = canonicalizeControlRepoPath(repo.path);
    if (canonical !== repo.path && paths.has(canonical)) {
      duplicateIds.push(repo.id);
    }
  }

  if (duplicateIds.length === 0) return repos;

  await prisma.repository.deleteMany({ where: { id: { in: duplicateIds } } });
  return repos.filter((repo) => !duplicateIds.includes(repo.id));
}

export async function listRepositories() {
  const repos = await prisma.repository.findMany({
    orderBy: { updatedAt: 'desc' },
    include: {
      _count: { select: { runs: true, slots: true } },
    },
  });
  return pruneWorktreeRepositoryDuplicates(repos);
}

export async function getRepository(id: string) {
  return prisma.repository.findUnique({
    where: { id },
    include: {
      slots: { orderBy: { slotId: 'asc' } },
      runs: { orderBy: { startedAt: 'desc' }, take: 20 },
    },
  });
}

export async function listActiveWorktrees() {
  // Require a path so stale `active: true` rows without a worktree (missed sync
  // after teardown) do not appear under Active sessions.
  return prisma.agentSlot.findMany({
    where: { active: true, worktreePath: { not: null } },
    include: {
      repository: { select: { id: true, path: true, gitRemote: true } },
    },
    orderBy: [{ updatedAt: 'desc' }],
  });
}

export async function syncRuns(repositoryId: string, input: unknown) {
  const { runs } = SyncRunsInputSchema.parse(input);

  for (const run of runs) {
    const parsed = RunRecordSchema.parse(run);
    await prisma.run.upsert({
      where: { repositoryId_runId: { repositoryId, runId: parsed.runId } },
      create: {
        runId: parsed.runId,
        repositoryId,
        stageId: parsed.stageId,
        kind: parsed.kind,
        agentId: parsed.agentId,
        status: parsed.status,
        trigger: parsed.trigger,
        durationMs: parsed.durationMs,
        startedAt: new Date(parsed.startedAt),
        finishedAt: parsed.finishedAt ? new Date(parsed.finishedAt) : null,
        workDir: parsed.workDir,
        workUnitId: parsed.workUnitId,
        attemptId: parsed.attemptId,
        result: parsed.result ? toJson(parsed.result) : undefined,
      },
      update: {
        status: parsed.status,
        durationMs: parsed.durationMs,
        finishedAt: parsed.finishedAt ? new Date(parsed.finishedAt) : null,
        workDir: parsed.workDir,
        workUnitId: parsed.workUnitId,
        attemptId: parsed.attemptId,
        result: parsed.result ? toJson(parsed.result) : undefined,
      },
    });
  }

  await prisma.repository.update({
    where: { id: repositoryId },
    data: { lastSyncAt: new Date() },
  });

  return { synced: runs.length };
}

export async function syncSlots(repositoryId: string, input: unknown) {
  const { slots } = SyncSlotsInputSchema.parse(input);

  for (const slot of slots) {
    const parsed = AgentSlotStatusSchema.parse(slot);
    const fields = buildAgentSlotSyncFields(parsed);
    // Prisma JSON columns need DbNull for SQL NULL (plain `null` is rejected).
    const data = {
      ...fields,
      previewUrls:
        fields.previewUrls === null ? Prisma.DbNull : fields.previewUrls,
    };
    await prisma.agentSlot.upsert({
      where: { repositoryId_slotId: { repositoryId, slotId: parsed.agentId } },
      create: {
        repositoryId,
        slotId: parsed.agentId,
        ...data,
      },
      update: data,
    });
  }

  return { synced: slots.length };
}

export async function listRuns(repositoryId: string, limit = 50) {
  return prisma.run.findMany({
    where: { repositoryId },
    orderBy: { startedAt: 'desc' },
    take: limit,
  });
}

export async function getRun(repositoryId: string, runId: string) {
  return prisma.run.findUnique({
    where: { repositoryId_runId: { repositoryId, runId } },
  });
}

export async function getRepositoryHealth(repositoryId: string) {
  const repo = await prisma.repository.findUnique({ where: { id: repositoryId } });
  if (!repo) return null;

  const recentRuns = await prisma.run.findMany({
    where: { repositoryId },
    orderBy: { startedAt: 'desc' },
    take: 100,
  });

  const verifyRuns = recentRuns.filter((r) => r.stageId === 'verify');
  const passCount = verifyRuns.filter((r) => r.status === 'pass').length;
  const mcpCount = recentRuns.filter((r) => r.trigger === 'mcp').length;
  const cliCount = recentRuns.filter((r) => r.trigger === 'cli').length;
  const scriptCount = recentRuns.filter((r) => r.trigger === 'script').length;

  return {
    repositoryId,
    manifest: repo.manifest,
    lastSyncAt: repo.lastSyncAt,
    harnessAdoption: {
      total: recentRuns.length,
      mcp: mcpCount,
      cli: cliCount,
      script: scriptCount,
      mcpPercent: recentRuns.length ? Math.round((mcpCount / recentRuns.length) * 100) : 0,
    },
    verificationTrend: {
      total: verifyRuns.length,
      pass: passCount,
      fail: verifyRuns.length - passCount,
      passRate: verifyRuns.length ? Math.round((passCount / verifyRuns.length) * 100) : 0,
    },
  };
}

export async function getVerificationTrend(repositoryId: string, days = 14) {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const runs = await prisma.run.findMany({
    where: {
      repositoryId,
      stageId: 'verify',
      startedAt: { gte: since },
    },
    orderBy: { startedAt: 'asc' },
  });

  return runs.map((r) => ({
    date: r.startedAt.toISOString().slice(0, 10),
    status: r.status,
    durationMs: r.durationMs,
    agentId: r.agentId,
  }));
}
