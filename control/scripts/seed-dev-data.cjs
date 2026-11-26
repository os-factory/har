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

const { repositoryKeyFor, repositoryUrl } = require('./migrate-db.cjs');

const SEED_FILE = path.join(__dirname, '../prisma/seed-data.json');
const STAGE_STATUS = { success: 'passed', failure: 'failed', skip: 'skipped' };

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
          occupancyKey: row.occupancyKey,
          result: row.result == null ? undefined : toJson(row.result),
        }),
      ),
    });
  }

  // The seed file keeps the 1.x shape (work units, attempts, validation bindings,
  // change batches, verification runs); load it into the v2 tables (ADR 0005).
  const repoKeys = new Map(seed.repositories.map((repo) => [repo.id, repositoryKeyFor(repo)]));
  const repoUrls = new Map(seed.repositories.map((repo) => [repo.id, repositoryUrl(repo.gitRemote)]));
  const unitById = new Map((seed.workUnits ?? []).map((row) => [row.id, row]));
  const attemptById = new Map((seed.workAttempts ?? []).map((row) => [row.id, row]));

  const unitKeys = new Set();
  for (const row of seed.workUnits ?? []) {
    const key = `${repoKeys.get(row.repositoryId)}\0${row.workUnitId}`;
    if (unitKeys.has(key)) continue;
    unitKeys.add(key);
    await prisma.workUnit.create({
      data: {
        id: row.id,
        repositoryKey: repoKeys.get(row.repositoryId),
        repositoryUrl: repoUrls.get(row.repositoryId),
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
      },
    });
  }

  for (const row of seed.workAttempts ?? []) {
    await prisma.attempt.create({
      data: {
        id: row.id,
        attemptId: row.attemptId,
        workUnitId: unitById.get(row.workUnitDbId)?.workUnitId ?? null,
        repositoryKey: repoKeys.get(row.repositoryId),
        repositoryUrl: repoUrls.get(row.repositoryId),
        repositoryId: row.repositoryId,
        slotId: String(row.agentId),
        agentId: row.agentId,
        sessionKey: row.sessionKey,
        workDir: row.workDir,
        worktreePath: row.worktreePath,
        branch: row.branch,
        baseCommit: row.baseCommit,
        startedAt: toDate(row.sourceCreatedAt),
      },
    });
  }

  const runs = new Map();
  const runFor = (validationId, base) => {
    const run = runs.get(validationId) ?? { factoryRunId: validationId, ...base };
    runs.set(validationId, run);
    return run;
  };
  for (const row of seed.changeBatches ?? []) {
    Object.assign(runFor(row.validationId, {}), compactRow({
      id: row.id,
      repositoryId: row.repositoryId,
      repositoryKey: repoKeys.get(row.repositoryId),
      tree: row.treeHash,
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
      occupancyKey: row.occupancyKey,
      startedAt: toDate(row.createdAt),
    }));
  }
  for (const row of seed.validationBindings ?? []) {
    const run = runFor(row.validationId, {
      repositoryId: row.repositoryId,
      repositoryKey: repoKeys.get(row.repositoryId),
      tree: row.treeHash,
      startedAt: toDate(row.sourceCreatedAt),
    });
    run.attemptId = attemptById.get(row.attemptDbId)?.attemptId ?? run.attemptId;
    run.workUnitId = unitById.get(row.workUnitDbId)?.workUnitId ?? run.workUnitId;
  }
  // Factory Commits proofs (HAR 2.0): verification runs received over OTLP, with their stages.
  const stageResults = [];
  for (const vr of seed.verificationRuns ?? []) {
    const run = runFor(vr.runId, {
      repositoryId: vr.repositoryId,
      repositoryKey: repoKeys.get(vr.repositoryId),
      tree: vr.treeHash ?? '',
      status: vr.result,
      startedAt: toDate(vr.startTime),
    });
    Object.assign(run, compactRow({
      verdict: vr.verdict,
      full: vr.verdict != null ? true : run.full,
      traceId: vr.traceId,
      spanId: vr.spanId,
      pipelineName: vr.pipelineName,
      producerVersion: vr.producerVersion,
      attestationDigest: vr.attestationDigest,
      policyId: vr.policyId,
      policyDigest: vr.policyDigest,
      finishedAt: toDate(vr.endTime),
    }));
    run.attemptId = run.attemptId ?? vr.attemptId;
    run.workUnitId = run.workUnitId ?? vr.workUnitId;
    run.branch = run.branch ?? vr.branch;
    const stages = vr.stages ?? [];
    run.stageIds = stages.map((stage) => stage.name);
    for (const stage of stages) {
      stageResults.push(compactRow({
        factoryRunId: vr.runId,
        stageId: stage.name,
        status: STAGE_STATUS[stage.result] ?? 'error',
        addedBy: stage.addedBy,
        kind: stage.taskType,
        durationMs: stage.endTime ? Date.parse(stage.endTime) - Date.parse(stage.startTime) : undefined,
        traceId: vr.traceId,
        spanId: stage.spanId,
        startTime: toDate(stage.startTime),
        endTime: toDate(stage.endTime),
      }));
    }
  }
  for (const run of runs.values()) await prisma.factoryRun.create({ data: compactRow(run) });
  if (stageResults.length) await prisma.stageResult.createMany({ data: stageResults });

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
