#!/usr/bin/env node
/**
 * Bring Mission Control's SQLite database to the current schema.
 *
 * Mission Control applies its schema with `prisma db push` (no migration
 * history). That is enough for additive changes, but the v2 data model
 * (ADR 0005 section 3) replaces tables, which `db push` would drop with their
 * data. This script runs instead of a bare `db push`:
 *
 * - a new or already-v2 database: `prisma db push` (unchanged behaviour);
 * - a 1.x database (it still has a replaced table such as `ChangeBatch`):
 *   1. snapshot it to `<db>.v1-backup` (`VACUUM INTO`, consistent);
 *   2. build the v2 database next to it, in `<db>.v2-tmp` (`prisma db push`);
 *   3. copy every row from the snapshot: tables that did not change as they
 *      are (common columns), replaced tables converted to the v2 tables;
 *   4. move `<db>.v2-tmp` over `<db>` (an atomic rename).
 *   Nothing is deleted: the 1.x data stays in the backup. A run interrupted
 *   before step 4 leaves `<db>` untouched and starts over on the next start.
 *
 * Usage (DATABASE_URL as for Prisma; extra arguments go to `prisma db push`):
 *   node scripts/migrate-db.cjs [--skip-generate]
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CONTROL_DIR = path.join(__dirname, '..');
const SCHEMA = path.join(CONTROL_DIR, 'prisma/schema.prisma');

/** Tables of the 1.x model that v2 replaces; any of them marks a 1.x database. */
const V1_TABLES = [
  'ChangeBatch',
  'VerificationRun',
  'VerificationStage',
  'ValidationBinding',
  'ValidationCommitBinding',
  'WorkAttempt',
  'SessionSlotBinding',
];

/**
 * Tables Mission Control no longer has. `prisma db push` refuses to drop a
 * table that holds rows, so they are dropped first; the 1.x backup keeps them.
 * `CloudConfig` held the settings of the removed Mission Control to hosted
 * receiver forwarding: the CLI sends to every receiver directly (ADR 0005).
 */
const RETIRED_TABLES = ['CloudConfig'];

/** v2 tables filled by explicit conversions, never by the generic copy. */
const CONVERTED_TABLES = new Set([
  'WorkUnit',
  'Attempt',
  'SessionSegment',
  'FactoryRun',
  'StageResult',
  'CommitBinding',
  'Attestation',
  'EvidenceBlob',
  'MetricSeries',
]);

function log(line) {
  process.stdout.write(`[migrate-db] ${line}\n`);
}

/** The SQLite file of a `file:` DATABASE_URL; relative paths resolve against the schema directory, as Prisma does. */
function databaseFile(url) {
  if (!url || !url.startsWith('file:')) throw new Error(`DATABASE_URL must be a SQLite file: URL (got ${url || 'nothing'})`);
  const raw = url.slice('file:'.length).split('?')[0];
  return path.isAbsolute(raw) ? raw : path.resolve(path.dirname(SCHEMA), raw);
}

function prismaCli(args, env) {
  let command = process.execPath;
  let argv;
  try {
    argv = [require.resolve('prisma/build/index.js', { paths: [CONTROL_DIR] }), ...args];
  } catch {
    command = 'npx';
    argv = ['prisma', ...args];
  }
  const result = spawnSync(command, argv, { stdio: 'inherit', env, cwd: CONTROL_DIR });
  if (result.status !== 0) throw new Error(`prisma ${args.join(' ')} failed (exit ${result.status})`);
}

function dbPush(file, extraArgs) {
  prismaCli(['db', 'push', '--schema', SCHEMA, ...extraArgs], { ...process.env, DATABASE_URL: `file:${file}` });
}

function loadPrismaClient() {
  try {
    return require('@prisma/client').PrismaClient;
  } catch {
    prismaCli(['generate', '--schema', SCHEMA], process.env);
    return require('@prisma/client').PrismaClient;
  }
}

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// --- repository key (keep in sync with `repositoryUrlKey` in src/server/repository-key.ts) ---

function gitRemoteBrowseUrl(remote) {
  if (!remote) return null;
  const trimmed = String(remote).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\.git$/i, '');
  const ssh = trimmed.match(/^git@([^:]+):(.+)$/i);
  if (ssh) return `https://${ssh[1]}/${ssh[2].replace(/\.git$/i, '')}`;
  const sshProtocol = trimmed.match(/^ssh:\/\/git@([^/]+)\/(.+)$/i);
  if (sshProtocol) return `https://${sshProtocol[1]}/${sshProtocol[2].replace(/\.git$/i, '')}`;
  return null;
}

/** Host and path of a remote, lowercased, without scheme, credentials or `.git`. */
function repositoryUrlKey(remote) {
  const browse = gitRemoteBrowseUrl(remote);
  if (!browse) return null;
  try {
    const url = new URL(browse);
    return `${url.hostname}${url.pathname}`.replace(/\/+$/, '').toLowerCase();
  } catch {
    return null;
  }
}

/** The remote as a repository URL without credentials (`vcs.repository.url.full`). */
function repositoryUrl(remote) {
  const browse = gitRemoteBrowseUrl(remote);
  if (!browse) return null;
  try {
    const url = new URL(browse);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

/** The key a registered repository's work units are scoped to: its remote, else the repository itself. */
function repositoryKeyFor(repository) {
  return repositoryUrlKey(repository.gitRemote) ?? `repo:${repository.id}`;
}

// --- conversion ---

async function columns(db, schema, table) {
  const rows = await db.$queryRawUnsafe(`PRAGMA ${schema}.table_info(${sqlString(table)})`);
  return rows.map((row) => row.name);
}

async function tableNames(db, schema) {
  const rows = await db.$queryRawUnsafe(
    `SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma%'`,
  );
  return rows.map((row) => row.name);
}

/** SQL statements converting the replaced 1.x tables (attached as `v1`) into the v2 tables. */
function conversionStatements(v1Tables) {
  const has = (name) => v1Tables.includes(name);
  const out = [];
  // Latest verify span per run id: one factory run holds the latest verify of its tree.
  const latestVerification = `SELECT vr.* FROM v1."VerificationRun" vr WHERE vr.id = (
      SELECT x.id FROM v1."VerificationRun" x WHERE x.runId = vr.runId ORDER BY x.startTime DESC, x.id DESC LIMIT 1)`;

  if (has('WorkUnit')) {
    out.push(`INSERT OR IGNORE INTO "WorkUnit" (id, repositoryKey, repositoryUrl, repositoryId, workUnitId, source, sourceUrl, title,
        parentWorkUnitId, relatedLinks, outcome, sourceCreatedAt, sourceUpdatedAt, createdAt, updatedAt)
      SELECT w.id, COALESCE(k.repositoryKey, 'repo:' || w.repositoryId), k.repositoryUrl, w.repositoryId, w.workUnitId, w.source,
        w.sourceUrl, w.title, w.parentWorkUnitId, w.relatedLinks, w.outcome, w.sourceCreatedAt, w.sourceUpdatedAt, w.createdAt, w.updatedAt
      FROM v1."WorkUnit" w LEFT JOIN temp.repo_keys k ON k.repositoryId = w.repositoryId
      ORDER BY w.sourceUpdatedAt DESC`);
  }
  if (has('WorkAttempt')) {
    out.push(`INSERT OR IGNORE INTO "Attempt" (id, attemptId, workUnitId, repositoryKey, repositoryUrl, repositoryId, slotId, agentId,
        branch, baseCommit, startedAt, sessionKey, workDir, worktreePath, createdAt, updatedAt)
      SELECT a.id, a.attemptId, w.workUnitId, COALESCE(k.repositoryKey, 'repo:' || a.repositoryId), k.repositoryUrl, a.repositoryId,
        CAST(a.agentId AS TEXT), a.agentId, a.branch, a.baseCommit, a.sourceCreatedAt, a.sessionKey, a.workDir, a.worktreePath,
        a.createdAt, a.updatedAt
      FROM v1."WorkAttempt" a
      LEFT JOIN v1."WorkUnit" w ON w.id = a.workUnitDbId
      LEFT JOIN temp.repo_keys k ON k.repositoryId = a.repositoryId`);
  }
  if (has('SessionSlotBinding')) {
    // Key: see `timelinePointKey` in src/server/session-attribution.ts.
    out.push(`INSERT OR IGNORE INTO "SessionSegment" (id, segmentKey, repositoryId, agentTool, sessionId, subagentId, kind, slotId,
        occupancyKey, branch, "from", origin, createdAt, updatedAt)
      SELECT b.id, json_array('point', b.repositoryId, b.agentTool, b.sessionId, b.subagentId, b.kind, b.slotId, b.at),
        b.repositoryId, b.agentTool, b.sessionId, b.subagentId, b.kind, b.slotId, b.occupancyKey, b.branch, b.at, b.origin,
        b.createdAt, b.createdAt
      FROM v1."SessionSlotBinding" b`);
  }
  if (has('ChangeBatch')) {
    out.push(`INSERT OR IGNORE INTO "FactoryRun" (id, factoryRunId, repositoryKey, repositoryId, tree, status, full, headSha, branch,
        workDir, agentId, runId, occupancyKey, changedFiles, commitSha, committedAt, startedAt, createdAt, updatedAt)
      SELECT c.id, c.validationId, COALESCE(k.repositoryKey, 'repo:' || c.repositoryId), c.repositoryId, c.treeHash, c.status, c.full,
        c.headSha, c.branch, c.workDir, c.agentId, c.runId, c.occupancyKey, c.changedFiles, c.commitSha, c.committedAt,
        c.createdAt, c.createdAt, c.updatedAt
      FROM v1."ChangeBatch" c LEFT JOIN temp.repo_keys k ON k.repositoryId = c.repositoryId
      ORDER BY c.createdAt DESC`);
  }
  if (has('VerificationRun')) {
    out.push(`INSERT OR IGNORE INTO "FactoryRun" (id, factoryRunId, repositoryKey, repositoryId, tree, status, headSha, branch,
        startedAt, createdAt, updatedAt)
      SELECT vr.id, vr.runId, COALESCE(k.repositoryKey, 'repo:' || vr.repositoryId), vr.repositoryId, COALESCE(vr.treeHash, ''),
        vr.result, vr.headRevision, vr.branch, vr.startTime, vr.createdAt, vr.updatedAt
      FROM (${latestVerification}) vr LEFT JOIN temp.repo_keys k ON k.repositoryId = vr.repositoryId`);
    out.push(`UPDATE "FactoryRun" SET
        verdict = lv.verdict,
        traceId = lv.traceId,
        spanId = lv.spanId,
        pipelineName = lv.pipelineName,
        producerVersion = lv.producerVersion,
        attestationDigest = lv.attestationDigest,
        policyId = lv.policyId,
        policyDigest = lv.policyDigest,
        workUnitId = COALESCE("FactoryRun".workUnitId, lv.workUnitId),
        attemptId = COALESCE("FactoryRun".attemptId, lv.attemptId),
        branch = COALESCE("FactoryRun".branch, lv.branch),
        headSha = COALESCE("FactoryRun".headSha, lv.headRevision),
        status = COALESCE("FactoryRun".status, lv.result),
        finishedAt = lv.endTime
      FROM (${latestVerification}) lv WHERE lv.runId = "FactoryRun".factoryRunId`);
  }
  if (has('ValidationBinding')) {
    out.push(`INSERT OR IGNORE INTO "FactoryRun" (id, factoryRunId, repositoryKey, repositoryId, tree, startedAt, createdAt, updatedAt)
      SELECT vb.id, vb.validationId, COALESCE(k.repositoryKey, 'repo:' || vb.repositoryId), vb.repositoryId, vb.treeHash,
        vb.sourceCreatedAt, vb.createdAt, vb.createdAt
      FROM v1."ValidationBinding" vb LEFT JOIN temp.repo_keys k ON k.repositoryId = vb.repositoryId
      ORDER BY vb.sourceCreatedAt DESC`);
    out.push(`UPDATE "FactoryRun" SET attemptId = b.attemptId, workUnitId = b.workUnitId
      FROM (SELECT vb.validationId, a.attemptId, w.workUnitId FROM v1."ValidationBinding" vb
            JOIN v1."WorkAttempt" a ON a.id = vb.attemptDbId
            JOIN v1."WorkUnit" w ON w.id = vb.workUnitDbId
            ORDER BY vb.sourceCreatedAt ASC) b
      WHERE b.validationId = "FactoryRun".factoryRunId`);
  }
  if (has('VerificationStage') && has('VerificationRun')) {
    out.push(`INSERT OR IGNORE INTO "StageResult" (id, factoryRunId, stageId, status, addedBy, kind, durationMs, traceId, spanId,
        startTime, endTime, createdAt, updatedAt)
      SELECT vs.id, lv.runId, vs.name,
        CASE vs.result WHEN 'success' THEN 'passed' WHEN 'failure' THEN 'failed' WHEN 'skip' THEN 'skipped' ELSE 'error' END,
        vs.addedBy, vs.taskType, CASE WHEN vs.endTime IS NULL THEN NULL ELSE vs.endTime - vs.startTime END,
        vs.traceId, vs.spanId, vs.startTime, vs.endTime, vs.createdAt, vs.createdAt
      FROM v1."VerificationStage" vs JOIN (${latestVerification}) lv ON lv.id = vs.verificationRunId
      ORDER BY vs.startTime ASC`);
    out.push(`UPDATE "FactoryRun" SET stageIds = s.ids
      FROM (SELECT factoryRunId, json_group_array(stageId) AS ids FROM
              (SELECT factoryRunId, stageId FROM "StageResult" ORDER BY startTime ASC) GROUP BY factoryRunId) s
      WHERE s.factoryRunId = "FactoryRun".factoryRunId`);
  }
  if (has('ValidationCommitBinding')) {
    out.push(`INSERT OR IGNORE INTO "CommitBinding" (id, commitSha, tree, factoryRunId, proofDigest, branch, repositoryId, parents,
        refs, message, runId, committedAt, createdAt, updatedAt)
      SELECT cb.id, cb.commitSha, cb.treeHash, cb.validationId, fr.attestationDigest, fr.branch, cb.repositoryId, cb.parents,
        cb.refs, cb.message, cb.runId, cb.sourceCreatedAt, cb.createdAt, cb.createdAt
      FROM v1."ValidationCommitBinding" cb LEFT JOIN "FactoryRun" fr ON fr.factoryRunId = cb.validationId
      ORDER BY cb.sourceCreatedAt DESC`);
  }
  // A provider-reported cost is stored as reported (ADR 0005 section 5); estimates are priced at ingest from now on.
  out.push(`UPDATE "UsageObservation" SET costSource = 'reported' WHERE costUsd IS NOT NULL AND costSource IS NULL`);
  return out;
}

async function copyFromBackup(file, backup) {
  const PrismaClient = loadPrismaClient();
  const db = new PrismaClient({ datasourceUrl: `file:${file}?connection_limit=1` });
  try {
    await db.$executeRawUnsafe(`ATTACH DATABASE ${sqlString(backup)} AS v1`);
    await db.$executeRawUnsafe('PRAGMA foreign_keys = OFF');
    const v1Tables = await tableNames(db, 'v1');
    const v2Tables = await tableNames(db, 'main');

    const repositories = v1Tables.includes('Repository')
      ? await db.$queryRawUnsafe('SELECT id, gitRemote FROM v1."Repository"')
      : [];
    const statements = [
      'CREATE TEMP TABLE IF NOT EXISTS repo_keys (repositoryId TEXT PRIMARY KEY, repositoryKey TEXT NOT NULL, repositoryUrl TEXT)',
      'DELETE FROM temp.repo_keys',
      ...repositories.map(
        (repo) =>
          `INSERT INTO temp.repo_keys VALUES (${sqlString(repo.id)}, ${sqlString(repositoryKeyFor(repo))}, ${
            repositoryUrl(repo.gitRemote) ? sqlString(repositoryUrl(repo.gitRemote)) : 'NULL'
          })`,
      ),
    ];

    // Tables that exist in both: copy the columns they share (Repository first, it is every row's parent).
    const shared = v2Tables
      .filter((table) => v1Tables.includes(table) && !CONVERTED_TABLES.has(table))
      .sort((a, b) => (a === 'Repository' ? -1 : b === 'Repository' ? 1 : a.localeCompare(b)));
    const copied = [];
    for (const table of shared) {
      const [v2Columns, v1Columns] = await Promise.all([columns(db, 'main', table), columns(db, 'v1', table)]);
      const common = v2Columns.filter((column) => v1Columns.includes(column)).map((column) => `"${column}"`);
      if (common.length === 0) continue;
      statements.push(`INSERT OR IGNORE INTO main."${table}" (${common.join(', ')}) SELECT ${common.join(', ')} FROM v1."${table}"`);
      copied.push(table);
    }
    statements.push(...conversionStatements(v1Tables));

    await db.$executeRawUnsafe('BEGIN');
    try {
      for (const statement of statements) await db.$executeRawUnsafe(statement);
      await db.$executeRawUnsafe('COMMIT');
    } catch (error) {
      await db.$executeRawUnsafe('ROLLBACK').catch(() => {});
      throw error;
    }
    const counts = {};
    for (const table of ['WorkUnit', 'Attempt', 'SessionSegment', 'FactoryRun', 'StageResult', 'CommitBinding']) {
      const [row] = await db.$queryRawUnsafe(`SELECT count(*) AS n FROM main."${table}"`);
      counts[table] = Number(row.n);
    }
    await db.$executeRawUnsafe('DETACH DATABASE v1');
    log(`copied ${copied.length} tables as they are (${copied.join(', ')})`);
    log(`converted to v2: ${Object.entries(counts).map(([table, n]) => `${table} ${n}`).join(', ')}`);
  } finally {
    await db.$disconnect();
  }
}

async function v1TablesIn(file) {
  const PrismaClient = loadPrismaClient();
  const db = new PrismaClient({ datasourceUrl: `file:${file}?connection_limit=1` });
  try {
    const names = await tableNames(db, 'main');
    return V1_TABLES.filter((table) => names.includes(table));
  } finally {
    await db.$disconnect();
  }
}

async function dropRetiredTables(file) {
  const PrismaClient = loadPrismaClient();
  const db = new PrismaClient({ datasourceUrl: `file:${file}?connection_limit=1` });
  try {
    const names = await tableNames(db, 'main');
    for (const table of RETIRED_TABLES.filter((name) => names.includes(name))) {
      await db.$executeRawUnsafe(`DROP TABLE "${table}"`);
      log(`dropped retired table ${table}`);
    }
  } finally {
    await db.$disconnect();
  }
}

/**
 * Unique indexes widened since a database was created. `prisma db push` asks
 * for `--accept-data-loss` before it adds a unique index to a table with rows,
 * even when an older index on fewer of the same columns already proves the
 * rows unique. Each is swapped here first, so the push finds it in place.
 * `AgentSessionSpan`: a span is (trace, span, start) — a resumed agent session
 * may reuse a span id for a new span.
 */
const WIDENED_UNIQUE_INDEXES = [
  {
    table: 'AgentSessionSpan',
    from: 'AgentSessionSpan_repositoryId_traceId_spanId_key',
    to: 'AgentSessionSpan_repositoryId_traceId_spanId_startTime_key',
    columns: ['repositoryId', 'traceId', 'spanId', 'startTime'],
  },
];

async function widenUniqueIndexes(file) {
  const PrismaClient = loadPrismaClient();
  const db = new PrismaClient({ datasourceUrl: `file:${file}?connection_limit=1` });
  try {
    const indexes = new Set(
      (await db.$queryRawUnsafe(`SELECT name FROM sqlite_master WHERE type = 'index'`)).map((row) => row.name),
    );
    for (const index of WIDENED_UNIQUE_INDEXES.filter((entry) => indexes.has(entry.from))) {
      const columns = index.columns.map((column) => `"${column}"`).join(', ');
      await db.$executeRawUnsafe(`CREATE UNIQUE INDEX IF NOT EXISTS "${index.to}" ON "${index.table}"(${columns})`);
      await db.$executeRawUnsafe(`DROP INDEX "${index.from}"`);
      log(`widened unique index ${index.from} to ${index.to}`);
    }
  } finally {
    await db.$disconnect();
  }
}

async function backupTo(file, backup) {
  const PrismaClient = loadPrismaClient();
  const db = new PrismaClient({ datasourceUrl: `file:${file}?connection_limit=1` });
  try {
    await db.$executeRawUnsafe(`VACUUM INTO ${sqlString(backup)}`);
  } finally {
    await db.$disconnect();
  }
}

function freeBackupPath(file) {
  const base = `${file}.v1-backup`;
  if (!fs.existsSync(base)) return base;
  return `${base}-${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * Fill where a factory run happened from its attempt (as `factory-run-placement.ts`
 * does at ingest), for v2 runs stored before Mission Control derived it: the
 * occupancy `attempt::<id>`, the attempt's slot number, the live slot's work dir.
 * Only empty columns are filled, so it is idempotent.
 */
async function placeFactoryRuns(file) {
  const PrismaClient = loadPrismaClient();
  const db = new PrismaClient({ datasourceUrl: `file:${file}?connection_limit=1` });
  try {
    const placed = await db.$executeRawUnsafe(`UPDATE "FactoryRun" SET "occupancyKey" = 'attempt::' || "attemptId"
      WHERE "attemptId" IS NOT NULL AND "occupancyKey" IS NULL`);
    await db.$executeRawUnsafe(`UPDATE "FactoryRun" SET "agentId" = (
        SELECT COALESCE(a."agentId", (SELECT s."slotId" FROM "AgentSlot" s WHERE s."occupancyKey" = 'attempt::' || "FactoryRun"."attemptId" LIMIT 1))
        FROM "Attempt" a WHERE a."attemptId" = "FactoryRun"."attemptId")
      WHERE "attemptId" IS NOT NULL AND "agentId" IS NULL`);
    await db.$executeRawUnsafe(`UPDATE "FactoryRun" SET "workDir" = (
        SELECT COALESCE(s."workDir", s."worktreePath") FROM "AgentSlot" s WHERE s."occupancyKey" = 'attempt::' || "FactoryRun"."attemptId" LIMIT 1)
      WHERE "attemptId" IS NOT NULL AND "workDir" IS NULL`);
    if (placed > 0) log(`placed ${placed} factory runs by their attempt`);
  } finally {
    await db.$disconnect();
  }
}

/** Migrate the database at `file` (see the header). Returns what was done. */
async function migrateDatabase(file, pushArgs = []) {
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    dbPush(file, pushArgs);
    return { migrated: false, backup: null };
  }
  const legacy = await v1TablesIn(file);
  if (legacy.length === 0) {
    await dropRetiredTables(file);
    await widenUniqueIndexes(file);
    dbPush(file, pushArgs);
    await placeFactoryRuns(file);
    return { migrated: false, backup: null };
  }
  const backup = freeBackupPath(file);
  const next = `${file}.v2-tmp`;
  log(`1.x database (${legacy.join(', ')}): migrating to the v2 data model, backup at ${backup}`);
  await backupTo(file, backup);
  for (const leftover of [next, `${next}-journal`, `${next}-wal`, `${next}-shm`]) fs.rmSync(leftover, { force: true });
  dbPush(next, pushArgs);
  await copyFromBackup(next, backup);
  await placeFactoryRuns(next);
  fs.renameSync(next, file);
  log('v2 migration done');
  return { migrated: true, backup };
}

module.exports = { migrateDatabase, databaseFile, repositoryUrlKey, repositoryKeyFor, repositoryUrl, V1_TABLES };

if (require.main === module) {
  migrateDatabase(databaseFile(process.env.DATABASE_URL), process.argv.slice(2)).catch((error) => {
    console.error(`[migrate-db] ${error instanceof Error ? error.stack || error.message : String(error)}`);
    process.exit(1);
  });
}
