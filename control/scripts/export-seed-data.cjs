#!/usr/bin/env node
/**
 * Export curated Mission Control seed data from a live SQLite database.
 *
 * Keeps real monorepo repos (har-project, control, docs) and drops ephemeral
 * /tmp fixture registrations. Omits heavy OTEL tables (events, spans, trajectory).
 *
 * Usage:
 *   node scripts/export-seed-data.cjs --source /path/to/har_control.db
 *   node scripts/export-seed-data.cjs --source /path/to/har_control.db --output prisma/seed-data.json
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const REPO_PATHS = [
  '/home/antoine/Documents/osfactory/har-project',
  '/home/antoine/Documents/osfactory/har-project/control',
  '/home/antoine/Documents/osfactory/har-project/docs',
];

const RUNS_PER_REPO = 20;
const WORK_UNITS_PER_REPO = 12;
const CHANGE_BATCHES_PER_REPO = 10;
const SESSION_USAGE_PER_REPO = 3;

/**
 * Occupancy key (#316). Source databases exported from a pre-1.4 Mission Control have none,
 * so derive it the same way control/src/server/occupancy.ts does.
 */
function deriveOccupancyKey(slot) {
  if (!slot.active) return null;
  if (slot.attemptId) return `attempt::${slot.attemptId}`;
  const createdAt = slot.sessionCreatedAt ? new Date(slot.sessionCreatedAt).toISOString() : null;
  if (slot.branch && createdAt) return `branch::${slot.branch}::${createdAt}`;
  const path = slot.worktreePath ?? slot.workDir;
  if (path && createdAt) return `path::${path}::${createdAt}`;
  return path ? `path::${path}` : null;
}

function parseArgs(argv) {
  const args = { source: '', output: path.join(__dirname, '../prisma/seed-data.json') };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--source') args.source = argv[++i];
    else if (argv[i] === '--output') args.output = argv[++i];
  }
  if (!args.source) {
    console.error('Usage: node scripts/export-seed-data.cjs --source <sqlite.db> [--output path]');
    process.exit(1);
  }
  return args;
}

function rows(db, sql, params = []) {
  return db.prepare(sql).all(...params);
}

function one(db, sql, params = []) {
  return db.prepare(sql).get(...params);
}

function parseJson(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function summarizeRunResult(result) {
  const parsed = parseJson(result);
  if (!parsed || typeof parsed !== 'object') return null;
  const summary = {
    status: parsed.status,
    stageId: parsed.stageId,
    kind: parsed.kind,
    code: parsed.code,
    durationMs: parsed.durationMs,
  };
  if (Array.isArray(parsed.stages)) {
    summary.stages = parsed.stages.map((stage) => ({
      name: stage.name,
      pass: stage.pass,
      ms: stage.ms,
    }));
  }
  if (parsed.data && typeof parsed.data === 'object') {
    summary.data = parsed.data;
  }
  return summary;
}

function summarizeChangedFiles(changedFiles) {
  const parsed = parseJson(changedFiles);
  if (!Array.isArray(parsed)) return parsed;
  if (parsed.length <= 8) return parsed;
  return parsed.slice(0, 8);
}

function toIso(value) {
  if (value == null) return null;
  return new Date(value).toISOString();
}

function bigintToString(value) {
  if (value == null) return '0';
  return String(value);
}

function exportRepository(db, repoPath, oldId, newId, idMap) {
  idMap.repositories.set(oldId, newId);
  const row = one(db, 'SELECT * FROM Repository WHERE id = ?', [oldId]);
  if (!row) return null;

  return {
    id: newId,
    path: repoPath,
    gitRemote: row.gitRemote ?? null,
    manifest: parseJson(row.manifest),
    stagesRegistry: parseJson(row.stagesRegistry),
    lastSyncAt: toIso(row.lastSyncAt),
  };
}

function exportRuns(db, repositoryId, newRepoId, idMap) {
  const runs = rows(
    db,
    `SELECT * FROM Run WHERE repositoryId = ? ORDER BY startedAt DESC LIMIT ${RUNS_PER_REPO}`,
    [repositoryId],
  );
  return runs.map((row) => {
    const id = crypto.randomUUID();
    idMap.runs.set(row.id, id);
    return {
      id,
      runId: row.runId,
      repositoryId: newRepoId,
      stageId: row.stageId,
      kind: row.kind,
      agentId: row.agentId,
      status: row.status,
      trigger: row.trigger,
      durationMs: row.durationMs,
      startedAt: toIso(row.startedAt),
      finishedAt: toIso(row.finishedAt),
      workDir: row.workDir,
      workUnitId: row.workUnitId,
      attemptId: row.attemptId,
      result: summarizeRunResult(row.result),
    };
  });
}

function exportWorkUnits(db, repositoryId, newRepoId, idMap) {
  const units = rows(
    db,
    `SELECT * FROM WorkUnit WHERE repositoryId = ? ORDER BY sourceUpdatedAt DESC LIMIT ${WORK_UNITS_PER_REPO}`,
    [repositoryId],
  );
  return units.map((row) => {
    const id = crypto.randomUUID();
    idMap.workUnits.set(row.id, id);
    idMap.workUnitKeys.set(`${repositoryId}:${row.workUnitId}`, { dbId: id, workUnitId: row.workUnitId });
    return {
      id,
      repositoryId: newRepoId,
      workUnitId: row.workUnitId,
      source: row.source,
      sourceUrl: row.sourceUrl,
      title: row.title,
      parentWorkUnitId: row.parentWorkUnitId,
      relatedLinks: parseJson(row.relatedLinks),
      outcome: parseJson(row.outcome),
      sourceCreatedAt: toIso(row.sourceCreatedAt),
      sourceUpdatedAt: toIso(row.sourceUpdatedAt),
    };
  });
}

function exportWorkAttempts(db, repositoryId, newRepoId, idMap) {
  const workUnitDbIds = [...idMap.workUnits.entries()]
    .filter(([oldDbId]) => {
      const row = one(db, 'SELECT repositoryId FROM WorkUnit WHERE id = ?', [oldDbId]);
      return row?.repositoryId === repositoryId;
    })
    .map(([oldDbId]) => oldDbId);

  if (workUnitDbIds.length === 0) return [];

  const placeholders = workUnitDbIds.map(() => '?').join(',');
  const attempts = rows(
    db,
    `SELECT * FROM WorkAttempt WHERE workUnitDbId IN (${placeholders}) ORDER BY sourceCreatedAt DESC`,
    workUnitDbIds,
  );

  return attempts.map((row) => {
    const id = crypto.randomUUID();
    idMap.workAttempts.set(row.id, id);
    const newWorkUnitDbId = idMap.workUnits.get(row.workUnitDbId);
    return {
      id,
      repositoryId: newRepoId,
      workUnitDbId: newWorkUnitDbId,
      attemptId: row.attemptId,
      agentId: row.agentId,
      sessionKey: row.sessionKey,
      workDir: row.workDir,
      worktreePath: row.worktreePath,
      branch: row.branch,
      baseCommit: row.baseCommit,
      sourceCreatedAt: toIso(row.sourceCreatedAt),
    };
  });
}

function exportValidationBindings(db, repositoryId, newRepoId, idMap) {
  const workUnitDbIds = [...idMap.workUnits.entries()]
    .filter(([oldDbId]) => {
      const row = one(db, 'SELECT repositoryId FROM WorkUnit WHERE id = ?', [oldDbId]);
      return row?.repositoryId === repositoryId;
    })
    .map(([oldDbId]) => oldDbId);

  if (workUnitDbIds.length === 0) return [];

  const placeholders = workUnitDbIds.map(() => '?').join(',');
  const bindings = rows(
    db,
    `SELECT * FROM ValidationBinding WHERE workUnitDbId IN (${placeholders}) ORDER BY sourceCreatedAt DESC`,
    workUnitDbIds,
  );

  return bindings.map((row) => {
    const id = crypto.randomUUID();
    return {
      id,
      repositoryId: newRepoId,
      bindingId: row.bindingId,
      workUnitDbId: idMap.workUnits.get(row.workUnitDbId),
      attemptDbId: idMap.workAttempts.get(row.attemptDbId),
      validationId: row.validationId,
      treeHash: row.treeHash,
      sourceCreatedAt: toIso(row.sourceCreatedAt),
    };
  }).filter((row) => row.workUnitDbId && row.attemptDbId);
}

function exportChangeBatches(db, repositoryId, newRepoId) {
  const batches = rows(
    db,
    `SELECT * FROM ChangeBatch WHERE repositoryId = ? ORDER BY createdAt DESC LIMIT ${CHANGE_BATCHES_PER_REPO}`,
    [repositoryId],
  );
  return batches.map((row) => ({
    id: crypto.randomUUID(),
    repositoryId: newRepoId,
    validationId: row.validationId,
    treeHash: row.treeHash,
    headSha: row.headSha,
    branch: row.branch,
    workDir: row.workDir,
    agentId: row.agentId,
    status: row.status,
    full: Boolean(row.full),
    runId: row.runId,
    changedFiles: summarizeChangedFiles(row.changedFiles),
    commitSha: row.commitSha,
    committedAt: toIso(row.committedAt),
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }));
}

function exportSlots(db, repositoryId, newRepoId) {
  const slots = rows(
    db,
    'SELECT * FROM AgentSlot WHERE repositoryId = ? ORDER BY slotId ASC',
    [repositoryId],
  );
  return slots.map((row) => ({
    id: crypto.randomUUID(),
    repositoryId: newRepoId,
    slotId: row.slotId,
    active: Boolean(row.active),
    workDir: row.workDir,
    worktreePath: row.worktreePath,
    branch: row.branch,
    previewUrls: parseJson(row.previewUrls),
    harnessUsage: row.harnessUsage ?? 'none',
    lastRunId: row.lastRunId,
    lastRunAt: toIso(row.lastRunAt),
    lastVerifyStatus: row.lastVerifyStatus,
    lastBuildPass: row.lastBuildPass == null ? null : Boolean(row.lastBuildPass),
    mode: row.mode,
    suffix: row.suffix,
    baseBranch: row.baseBranch,
    baseCommit: row.baseCommit,
    sessionCreatedAt: toIso(row.sessionCreatedAt),
    purpose: row.purpose,
    occupancyKey: row.occupancyKey ?? deriveOccupancyKey(row),
    workUnitId: row.workUnitId,
    attemptId: row.attemptId,
    detachedHead: row.detachedHead == null ? null : Boolean(row.detachedHead),
    dirty: row.dirty == null ? null : Boolean(row.dirty),
    ahead: row.ahead,
    behind: row.behind,
    stale: row.stale == null ? null : Boolean(row.stale),
  }));
}

function exportSessionUsage(db, repositoryId, newRepoId) {
  const usage = rows(
    db,
    `SELECT * FROM AgentSessionUsage WHERE repositoryId = ? ORDER BY lastSeenAt DESC LIMIT ${SESSION_USAGE_PER_REPO}`,
    [repositoryId],
  );
  return usage.map((row) => ({
    id: crypto.randomUUID(),
    repositoryId: newRepoId,
    sessionKey: row.sessionKey,
    agentId: row.agentId,
    agentTool: row.agentTool,
    workDir: row.workDir,
    branch: row.branch,
    suffix: row.suffix,
    occupancyKey: row.occupancyKey,
    workUnitId: row.workUnitId,
    attemptId: row.attemptId,
    tokensInput: bigintToString(row.tokensInput),
    tokensOutput: bigintToString(row.tokensOutput),
    tokensCacheRead: bigintToString(row.tokensCacheRead),
    tokensCacheCreation: bigintToString(row.tokensCacheCreation),
    tokensTotal: bigintToString(row.tokensTotal),
    costUsd: row.costUsd == null ? null : String(row.costUsd),
    modelBreakdown: parseJson(row.modelBreakdown),
    sources: parseJson(row.sources) ?? [],
    harvestVersion: row.harvestVersion ?? 0,
    firstSeenAt: toIso(row.firstSeenAt),
    lastSeenAt: toIso(row.lastSeenAt),
  }));
}

function main() {
  const { source, output } = parseArgs(process.argv);
  const resolvedSource = path.resolve(source);
  if (!fs.existsSync(resolvedSource)) {
    console.error(`Source database not found: ${resolvedSource}`);
    process.exit(1);
  }

  const db = new DatabaseSync(resolvedSource, { readOnly: true });
  const idMap = {
    repositories: new Map(),
    runs: new Map(),
    workUnits: new Map(),
    workUnitKeys: new Map(),
    workAttempts: new Map(),
  };

  const seed = {
    version: 1,
    exportedAt: new Date().toISOString(),
    source: path.basename(resolvedSource),
    repositories: [],
    runs: [],
    workUnits: [],
    workAttempts: [],
    validationBindings: [],
    changeBatches: [],
    agentSlots: [],
    sessionUsage: [],
  };

  for (const repoPath of REPO_PATHS) {
    const repoRow = one(db, 'SELECT id FROM Repository WHERE path = ?', [repoPath]);
    if (!repoRow) {
      process.stderr.write(`Skipping missing repo: ${repoPath}\n`);
      continue;
    }

    const newRepoId = crypto.randomUUID();
    const repository = exportRepository(db, repoPath, repoRow.id, newRepoId, idMap);
    if (!repository) continue;

    seed.repositories.push(repository);
    seed.runs.push(...exportRuns(db, repoRow.id, newRepoId, idMap));
    seed.workUnits.push(...exportWorkUnits(db, repoRow.id, newRepoId, idMap));
    seed.workAttempts.push(...exportWorkAttempts(db, repoRow.id, newRepoId, idMap));
    seed.validationBindings.push(...exportValidationBindings(db, repoRow.id, newRepoId, idMap));
    seed.changeBatches.push(...exportChangeBatches(db, repoRow.id, newRepoId));
    seed.agentSlots.push(...exportSlots(db, repoRow.id, newRepoId));
    seed.sessionUsage.push(...exportSessionUsage(db, repoRow.id, newRepoId));
  }

  db.close();

  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(path.resolve(output), `${JSON.stringify(seed, null, 2)}\n`);

  process.stdout.write(
    `Exported seed data to ${path.resolve(output)} ` +
      `(${seed.repositories.length} repos, ${seed.runs.length} runs, ` +
      `${seed.workUnits.length} work units, ${seed.agentSlots.length} slots)\n`,
  );
}

main();
