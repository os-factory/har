import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { StageEvidenceFile } from '../harness/schema';

/**
 * Stage evidence (ADR 0005 section 4).
 *
 * The verify runner keeps each stage's combined output (last 1 MiB, header
 * included) and records which files each stage created or changed under the
 * slot's `.har/<artifactsDir>/`. It writes them to a staging directory because
 * the factory run id (the validation id) is only known once the verified tree
 * is hashed, after the run. `finalizeStageEvidence` then moves the logs to
 * `.har/<artifactsDir>/<factory-run-id>/<stage-id>.log` and hashes every file.
 *
 * Attribution: a file belongs to a stage when it is new or changed (size,
 * mtime or inode) between the snapshots taken right before and right after the
 * stage, excluding other factory runs' log directories (top-level UUID names)
 * and the staging directory. A file a later stage rewrites is listed under
 * both stages; digests are taken once, after the whole verify, so both list
 * the final bytes. At most 1000 files per stage are attributed.
 *
 * Names are relative to `.har/<artifactsDir>/` (e.g. `<run-id>/unit-tests.log`,
 * `browser-e2e/screenshots/home.png`), never absolute paths.
 */

export const STAGE_LOG_STAGING_DIR = '.staging';
export const STAGE_LOG_INDEX = 'index.json';
export const STAGE_LOG_MEDIA_TYPE = 'text/plain; charset=utf-8';
/** Bytes of a stage log kept on disk, header line included. */
export const STAGE_LOG_LIMIT_BYTES = 1024 * 1024;

export interface StageEvidence {
  stageId: string;
  /** sha256 of the kept log, null when no log was written. */
  logDigest: string | null;
  /** The log first (when kept), then the stage's artifact files by name. */
  files: StageEvidenceFile[];
}

/** `<workDir>/.har/<artifactsDir>` */
export function slotArtifactsRoot(workDir: string, artifactsDirName: string): string {
  return path.join(workDir, '.har', artifactsDirName);
}

/** A fresh staging directory for one verify's stage logs (created by the runner). */
export function stageLogStagingDir(artifactsRoot: string): string {
  return path.join(artifactsRoot, STAGE_LOG_STAGING_DIR, crypto.randomUUID());
}

const MEDIA_TYPES: Record<string, string> = {
  '.log': STAGE_LOG_MEDIA_TYPE,
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
};

export function evidenceMediaType(name: string): string {
  return MEDIA_TYPES[path.extname(name).toLowerCase()] ?? 'application/octet-stream';
}

/** sha256 and size of a file, streamed in chunks. */
export function hashFile(file: string): { sha256: string; size: number } {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const chunk = Buffer.alloc(1024 * 1024);
  let size = 0;
  try {
    for (;;) {
      const read = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      hash.update(chunk.subarray(0, read));
      size += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { sha256: hash.digest('hex'), size };
}

interface RunnerIndex {
  stages: Array<{ id: string; log: string | null; artifacts: string[] }>;
}

function readRunnerIndex(dir: string): RunnerIndex | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, STAGE_LOG_INDEX), 'utf8')) as {
      stages?: unknown;
    };
    if (!Array.isArray(raw.stages)) return undefined;
    const stages: RunnerIndex['stages'] = [];
    for (const entry of raw.stages as Array<Record<string, unknown>>) {
      if (!entry || typeof entry.id !== 'string') continue;
      stages.push({
        id: entry.id,
        log: typeof entry.log === 'string' ? entry.log : null,
        artifacts: Array.isArray(entry.artifacts)
          ? entry.artifacts.filter((name): name is string => typeof name === 'string')
          : [],
      });
    }
    return { stages };
  } catch {
    return undefined;
  }
}

/** A relative name that stays inside the artifacts root. */
function safeRelativeName(name: string): string | undefined {
  const normalized = name.split(/[\\/]+/).filter(Boolean);
  if (normalized.length === 0 || normalized.includes('..') || path.isAbsolute(name)) return undefined;
  return normalized.join('/');
}

function evidenceFile(artifactsRoot: string, name: string): StageEvidenceFile | undefined {
  const file = path.join(artifactsRoot, ...name.split('/'));
  try {
    if (!fs.lstatSync(file).isFile()) return undefined;
    const { sha256, size } = hashFile(file);
    return { name, sha256, size, mediaType: evidenceMediaType(name) };
  } catch {
    return undefined;
  }
}

/** Remove a staging directory and the `.staging` parent once it is empty. Never throws. */
export function discardStageLogStaging(stagingDir: string): void {
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    const parent = path.dirname(stagingDir);
    if (path.basename(parent) === STAGE_LOG_STAGING_DIR && fs.readdirSync(parent).length === 0) {
      fs.rmdirSync(parent);
    }
  } catch {
    // best effort
  }
}

/**
 * Move one verify's staged logs to `<artifactsRoot>/<factoryRunId>/` (replacing
 * the logs of an earlier verify of the same tree) and hash every log and
 * attributed artifact. Returns undefined when the runner wrote no index (an
 * older runner, or a custom verify command).
 */
export function finalizeStageEvidence(input: {
  stagingDir: string;
  artifactsRoot: string;
  factoryRunId: string;
}): StageEvidence[] | undefined {
  const index = readRunnerIndex(input.stagingDir);
  if (!index) {
    discardStageLogStaging(input.stagingDir);
    return undefined;
  }
  const runDirName = safeRelativeName(input.factoryRunId);
  if (!runDirName || runDirName.includes('/')) {
    discardStageLogStaging(input.stagingDir);
    return undefined;
  }
  const runDir = path.join(input.artifactsRoot, runDirName);
  fs.rmSync(path.join(input.stagingDir, STAGE_LOG_INDEX), { force: true });
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.renameSync(input.stagingDir, runDir);
  discardStageLogStaging(input.stagingDir);

  return index.stages.map((stage) => {
    const files: StageEvidenceFile[] = [];
    let logDigest: string | null = null;
    const logName = stage.log ? safeRelativeName(stage.log) : undefined;
    if (logName && !logName.includes('/')) {
      const log = evidenceFile(input.artifactsRoot, `${runDirName}/${logName}`);
      if (log) {
        files.push({ ...log, mediaType: STAGE_LOG_MEDIA_TYPE });
        logDigest = log.sha256;
      }
    }
    const seen = new Set(files.map((file) => file.name));
    for (const raw of stage.artifacts) {
      const name = safeRelativeName(raw);
      if (!name || seen.has(name) || name.startsWith(`${STAGE_LOG_STAGING_DIR}/`)) continue;
      seen.add(name);
      const file = evidenceFile(input.artifactsRoot, name);
      if (file) files.push(file);
    }
    return { stageId: stage.id, logDigest, files };
  });
}

/**
 * Where one verify of a slot stages its logs, or undefined when logs must not
 * be written there: the staging path is not ignored by git, so writing it
 * would change the very tree the verify hashes. Outside a git checkout there
 * is no tree to protect.
 */
export function prepareStageLogStaging(input: {
  workDir: string | undefined;
  artifactsDirName: string;
}): { stagingDir: string; artifactsRoot: string } | undefined {
  if (!input.workDir || !fs.existsSync(path.join(input.workDir, '.har'))) return undefined;
  const artifactsRoot = slotArtifactsRoot(input.workDir, input.artifactsDirName);
  const stagingDir = stageLogStagingDir(artifactsRoot);
  const probe = spawnSync('git', ['check-ignore', '-q', '--no-index', path.join(stagingDir, STAGE_LOG_INDEX)], {
    cwd: input.workDir,
    stdio: 'ignore',
    timeout: 5000,
  });
  if (probe.status === 1) return undefined;
  if (probe.status !== 0 && probe.status !== 128) return undefined;
  return { stagingDir, artifactsRoot };
}
