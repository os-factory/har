import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ValidationRecord, ValidationRecordSchema } from '../harness/schema';
import { computeWorktreeSnapshot, isCheckoutRoot } from './change-batch';
import { markDirty } from './sync-context';

export const VALIDATIONS_DIR = 'validations';

/**
 * Pick the git checkout root to snapshot for a validation record.
 * Nested harnesses (e.g. `control/`) often set workDir to a subdirectory;
 * prefer the linked worktree root when present.
 */
export function resolveValidationCheckoutDir(input: {
  worktreePath?: string;
  workDir?: string;
  harnessRoot: string;
}): string {
  const candidates = [input.worktreePath, input.workDir, input.harnessRoot].filter(
    (value): value is string => Boolean(value),
  );
  return candidates.find(isCheckoutRoot) ?? candidates[0] ?? input.harnessRoot;
}

function getValidationsDir(checkoutDir: string): string {
  return path.join(checkoutDir, '.har', VALIDATIONS_DIR);
}

function validationPath(checkoutDir: string, treeHash: string): string {
  return path.join(getValidationsDir(checkoutDir), `${treeHash}.json`);
}

function writeRecord(checkoutDir: string, record: ValidationRecord): void {
  const dir = getValidationsDir(checkoutDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    validationPath(checkoutDir, record.treeHash),
    `${JSON.stringify(record, null, 2)}\n`,
  );
}

/**
 * Make sure validation records never perturb the tree hash they key: append
 * `validations/` to the checkout's .har/.gitignore if missing (older repos
 * were scaffolded before this feature existed).
 */
export function ensureValidationsIgnored(checkoutDir: string): void {
  const harDir = path.join(checkoutDir, '.har');
  if (!fs.existsSync(harDir)) return;
  const gitignorePath = path.join(harDir, '.gitignore');
  const content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  if (content.split('\n').some((line) => line.trim() === `${VALIDATIONS_DIR}/`)) return;
  const suffix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(gitignorePath, `${content}${suffix}${VALIDATIONS_DIR}/\n`);
}

export interface RecordValidationInput {
  checkoutDir: string;
  harnessRoot: string;
  status: 'pass' | 'fail';
  full: boolean;
  runId?: string;
  agentId?: number;
}

/**
 * Snapshot the checkout's working tree and persist a validation record keyed
 * by its tree hash. Written to the checkout (where the pre-commit hook looks)
 * and mirrored to the harness root (central copy for Mission Control sync).
 */
export function recordValidation(input: RecordValidationInput): ValidationRecord {
  if (!isCheckoutRoot(input.checkoutDir)) {
    throw new Error(`Not the root of a git checkout: ${input.checkoutDir}`);
  }

  ensureValidationsIgnored(input.checkoutDir);
  ensureValidationsIgnored(input.harnessRoot);
  const snapshot = computeWorktreeSnapshot(input.checkoutDir);
  const now = new Date().toISOString();
  const existing = findValidation(input.checkoutDir, snapshot.treeHash);

  const record: ValidationRecord = ValidationRecordSchema.parse({
    validationId: existing?.validationId ?? crypto.randomUUID(),
    treeHash: snapshot.treeHash,
    headSha: snapshot.headSha,
    branch: snapshot.branch,
    workDir: path.resolve(input.checkoutDir),
    harnessRoot: path.resolve(input.harnessRoot),
    agentId: input.agentId,
    status: input.status,
    full: input.full,
    runId: input.runId,
    changedFiles: snapshot.changedFiles,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    commitSha: existing?.commitSha,
    committedAt: existing?.committedAt,
  });

  writeRecord(input.checkoutDir, record);
  if (path.resolve(input.harnessRoot) !== path.resolve(input.checkoutDir)) {
    writeRecord(input.harnessRoot, record);
  }
  markDirty(input.checkoutDir);
  return record;
}

export function findValidation(
  checkoutDir: string,
  treeHash: string,
): ValidationRecord | undefined {
  const file = validationPath(checkoutDir, treeHash);
  if (!fs.existsSync(file)) return undefined;
  try {
    return ValidationRecordSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

/**
 * Associate a commit with the validation for its tree. Updates the checkout
 * copy and mirrors to the harness root recorded on the validation itself.
 */
export function attachCommit(
  checkoutDir: string,
  treeHash: string,
  commitSha: string,
): ValidationRecord | undefined {
  const record = findValidation(checkoutDir, treeHash);
  if (!record) return undefined;

  const updated: ValidationRecord = {
    ...record,
    commitSha,
    committedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  writeRecord(checkoutDir, updated);
  if (
    record.harnessRoot &&
    path.resolve(record.harnessRoot) !== path.resolve(checkoutDir) &&
    fs.existsSync(path.join(record.harnessRoot, '.har'))
  ) {
    writeRecord(record.harnessRoot, updated);
  }
  return updated;
}

export function listValidations(harnessRoot: string): ValidationRecord[] {
  const dir = getValidationsDir(harnessRoot);
  if (!fs.existsSync(dir)) return [];

  const records: ValidationRecord[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue;
    try {
      records.push(ValidationRecordSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8'))));
    } catch {
      // skip unreadable/invalid records
    }
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
