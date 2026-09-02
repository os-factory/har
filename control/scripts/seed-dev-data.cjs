#!/usr/bin/env node
/**
 * Load curated Mission Control seed data into a fresh slot SQLite database.
 *
 * Idempotent: skips when repositories already exist (e.g. after a prior seed or
 * live sync). Intended as HARNESS_DB_SEED_CMD after `prisma db push`.
 *
 * Usage:
 *   DATABASE_URL=file:./prisma/agent_1.db node scripts/seed-dev-data.cjs
 */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const SEED_FILE = path.join(__dirname, '../prisma/seed-data.json');

function toDate(value) {
  return value ? new Date(value) : undefined;
}

function toJson(value) {
  if (value == null) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function toBigInt(value) {
  if (value == null) return 0n;
  return BigInt(value);
}

function toDecimal(value) {
  if (value == null) return null;
  return value;
}

function compactRow(row) {
  return Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== undefined && value !== null),
  );
}

async function loadSeed(prisma) {
  if (!fs.existsSync(SEED_FILE)) {
    throw new Error(`Seed file not found: ${SEED_FILE}`);
  }

  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));

  for (const repo of seed.repositories) {
    await prisma.repository.create({
      data: compactRow({
        id: repo.id,
        path: repo.path,
        gitRemote: repo.gitRemote,
        manifest: toJson(repo.manifest),
        stagesRegistry: toJson(repo.stagesRegistry),
        lastSyncAt: toDate(repo.lastSyncAt),
      }),
    });
  }

  if (seed.runs?.length) {
    await prisma.run.createMany({
      data: seed.runs.map((row) =>
        compactRow({
          id: row.id,
          runId: row.runId,
          repositoryId: row.repositoryId,
          stageId: row.stageId,
          kind: row.kind,
          agentId: row.agentId,
          status: row.status,
          trigger: row.trigger,
          durationMs: row.durationMs,
          startedAt: toDate(row.startedAt),
          finishedAt: toDate(row.finishedAt),
          workDir: row.workDir,
          workUnitId: row.workUnitId,
          attemptId: row.attemptId,
          result: row.result == null ? undefined : toJson(row.result),
        }),
      ),
    });
  }

  if (seed.workUnits?.length) {
    await prisma.workUnit.createMany({
      data: seed.workUnits.map((row) => ({
        id: row.id,
        repositoryId: row.repositoryId,
        workUnitId: row.workUnitId,
        source: row.source,
        sourceUrl: row.sourceUrl,
        title: row.title,
        parentWorkUnitId: row.parentWorkUnitId,
        relatedLinks: toJson(row.relatedLinks),
        outcome: toJson(row.outcome),
        sourceCreatedAt: toDate(row.sourceCreatedAt),
        sourceUpdatedAt: toDate(row.sourceUpdatedAt),
      })),
    });
  }

  if (seed.workAttempts?.length) {
    await prisma.workAttempt.createMany({
      data: seed.workAttempts.map((row) => ({
        id: row.id,
        repositoryId: row.repositoryId,
        workUnitDbId: row.workUnitDbId,
        attemptId: row.attemptId,
        agentId: row.agentId,
        sessionKey: row.sessionKey,
        workDir: row.workDir,
        worktreePath: row.worktreePath,
        branch: row.branch,
        baseCommit: row.baseCommit,
        sourceCreatedAt: toDate(row.sourceCreatedAt),
      })),
    });
  }

  if (seed.validationBindings?.length) {
    await prisma.validationBinding.createMany({
      data: seed.validationBindings.map((row) => ({
        id: row.id,
        repositoryId: row.repositoryId,
        bindingId: row.bindingId,
        workUnitDbId: row.workUnitDbId,
        attemptDbId: row.attemptDbId,
        validationId: row.validationId,
        treeHash: row.treeHash,
        sourceCreatedAt: toDate(row.sourceCreatedAt),
      })),
    });
  }

  if (seed.changeBatches?.length) {
    await prisma.changeBatch.createMany({
      data: seed.changeBatches.map((row) => ({
        id: row.id,
        repositoryId: row.repositoryId,
        validationId: row.validationId,
        treeHash: row.treeHash,
        headSha: row.headSha,
        branch: row.branch,
        workDir: row.workDir,
        agentId: row.agentId,
        status: row.status,
        full: row.full,
        runId: row.runId,
        changedFiles: toJson(row.changedFiles),
        commitSha: row.commitSha,
        committedAt: toDate(row.committedAt),
        createdAt: toDate(row.createdAt),
        updatedAt: toDate(row.updatedAt),
      })),
    });
  }

  if (seed.agentSlots?.length) {
    await prisma.agentSlot.createMany({
      data: seed.agentSlots.map((row) => ({
        id: row.id,
        repositoryId: row.repositoryId,
        slotId: row.slotId,
        active: row.active,
        workDir: row.workDir,
        worktreePath: row.worktreePath,
        branch: row.branch,
        previewUrls: toJson(row.previewUrls),
        harnessUsage: row.harnessUsage ?? 'none',
        lastRunId: row.lastRunId,
        lastRunAt: toDate(row.lastRunAt),
        lastVerifyStatus: row.lastVerifyStatus,
        lastBuildPass: row.lastBuildPass,
        mode: row.mode,
        suffix: row.suffix,
        baseBranch: row.baseBranch,
        baseCommit: row.baseCommit,
        sessionCreatedAt: toDate(row.sessionCreatedAt),
        purpose: row.purpose,
        occupancyKey: row.occupancyKey,
        workUnitId: row.workUnitId,
        attemptId: row.attemptId,
        detachedHead: row.detachedHead,
        dirty: row.dirty,
        ahead: row.ahead,
        behind: row.behind,
        stale: row.stale,
      })),
    });
  }

  if (seed.sessionUsage?.length) {
    for (const row of seed.sessionUsage) {
      await prisma.agentSessionUsage.create({
        data: {
          id: row.id,
          repositoryId: row.repositoryId,
          sessionKey: row.sessionKey,
          agentId: row.agentId,
          agentTool: row.agentTool,
          workDir: row.workDir,
          branch: row.branch,
          suffix: row.suffix,
          occupancyKey: row.occupancyKey,
          workUnitId: row.workUnitId,
          attemptId: row.attemptId,
          tokensInput: toBigInt(row.tokensInput),
          tokensOutput: toBigInt(row.tokensOutput),
          tokensCacheRead: toBigInt(row.tokensCacheRead),
          tokensCacheCreation: toBigInt(row.tokensCacheCreation),
          tokensTotal: toBigInt(row.tokensTotal),
          costUsd: toDecimal(row.costUsd),
          modelBreakdown: toJson(row.modelBreakdown),
          sources: toJson(row.sources) ?? [],
          harvestVersion: row.harvestVersion ?? 0,
          firstSeenAt: toDate(row.firstSeenAt),
          lastSeenAt: toDate(row.lastSeenAt),
        },
      });
    }
  }

  return seed;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const existing = await prisma.repository.count();
    if (existing > 0) {
      process.stdout.write(`Seed skipped — database already has ${existing} repositories\n`);
      return;
    }

    const seed = await loadSeed(prisma);
    process.stdout.write(
      `Seeded Mission Control dev data ` +
        `(${seed.repositories.length} repos, ${seed.runs.length} runs, ` +
        `${seed.workUnits.length} work units, ${seed.agentSlots.length} slots)\n`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
