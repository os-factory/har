import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  ValidationBindingRecord,
  ValidationBindingRecordSchema,
  ValidationRecord,
  WorkAttemptRecord,
  WorkAttemptRecordSchema,
  WorkUnitMetadata,
  WorkUnitMetadataSchema,
  WorkUnitOutcome,
  WorkUnitRecord,
  WorkUnitRecordSchema,
} from '../harness/schema';
import { markDirty } from './sync-context';

const WORK_UNITS_DIR = 'work-units';
const WORK_ATTEMPTS_DIR = 'work-attempts';
const VALIDATION_BINDINGS_DIR = 'validation-bindings';
const EVIDENCE_DIRS = [WORK_UNITS_DIR, WORK_ATTEMPTS_DIR, VALIDATION_BINDINGS_DIR];

function harEvidenceDir(harnessRoot: string, name: string): string {
  return path.join(harnessRoot, '.har', name);
}

function hashedRecordPath(harnessRoot: string, dir: string, id: string): string {
  const digest = crypto.createHash('sha256').update(id).digest('hex');
  return path.join(harEvidenceDir(harnessRoot, dir), `${digest}.json`);
}

function writeRecord(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, file);
}

export function ensureWorkEvidenceIgnored(harnessRoot: string): void {
  const harDir = path.join(harnessRoot, '.har');
  if (!fs.existsSync(harDir)) return;
  const gitignorePath = path.join(harDir, '.gitignore');
  const content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const lines = new Set(content.split('\n').map((line) => line.trim()));
  const missing = EVIDENCE_DIRS.map((dir) => `${dir}/`).filter((dir) => !lines.has(dir));
  if (missing.length === 0) return;
  const separator = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(gitignorePath, `${content}${separator}${missing.join('\n')}\n`);
}

function listRecords<T>(
  harnessRoot: string,
  dir: string,
  parse: (value: unknown) => T,
): T[] {
  const recordDir = harEvidenceDir(harnessRoot, dir);
  if (!fs.existsSync(recordDir)) return [];
  const records: T[] = [];
  for (const name of fs.readdirSync(recordDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      records.push(parse(JSON.parse(fs.readFileSync(path.join(recordDir, name), 'utf8'))));
    } catch {
      // Preserve forward/backward compatibility by ignoring unreadable records.
    }
  }
  return records;
}

export function findWorkUnit(
  harnessRoot: string,
  workUnitId: string,
): WorkUnitRecord | undefined {
  const metadata = WorkUnitMetadataSchema.parse({ workUnitId });
  const file = hashedRecordPath(harnessRoot, WORK_UNITS_DIR, metadata.workUnitId);
  if (!fs.existsSync(file)) return undefined;
  try {
    return WorkUnitRecordSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return undefined;
  }
}

export function upsertWorkUnit(
  harnessRoot: string,
  input: WorkUnitMetadata,
): WorkUnitRecord {
  const metadata = WorkUnitMetadataSchema.parse(input);
  ensureWorkEvidenceIgnored(harnessRoot);
  const existing = findWorkUnit(harnessRoot, metadata.workUnitId);
  if (existing) {
    if (existing.outcome) {
      throw new Error(
        `Work unit ${metadata.workUnitId} is already ${existing.outcome.decision}; reopening is not supported`,
      );
    }
    for (const field of ['source', 'sourceUrl', 'title', 'parentWorkUnitId'] as const) {
      if (
        metadata[field] !== undefined &&
        existing[field] !== undefined &&
        metadata[field] !== existing[field]
      ) {
        throw new Error(
          `Work unit ${metadata.workUnitId} has immutable ${field}=${existing[field]}`,
        );
      }
    }
  }
  const now = new Date().toISOString();
  const record = WorkUnitRecordSchema.parse({
    ...existing,
    workUnitId: metadata.workUnitId,
    source: existing?.source ?? metadata.source,
    sourceUrl: existing?.sourceUrl ?? metadata.sourceUrl,
    title: existing?.title ?? metadata.title,
    parentWorkUnitId: existing?.parentWorkUnitId ?? metadata.parentWorkUnitId,
    version: 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    outcome: existing?.outcome,
  });
  writeRecord(
    hashedRecordPath(harnessRoot, WORK_UNITS_DIR, metadata.workUnitId),
    record,
  );
  markDirty(harnessRoot);
  return record;
}

export function listWorkUnits(harnessRoot: string): WorkUnitRecord[] {
  return listRecords(harnessRoot, WORK_UNITS_DIR, (value) =>
    WorkUnitRecordSchema.parse(value),
  ).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createWorkAttempt(
  harnessRoot: string,
  input: Omit<WorkAttemptRecord, 'version' | 'createdAt'> & { createdAt?: string },
): WorkAttemptRecord {
  const attempt = WorkAttemptRecordSchema.parse({
    ...input,
    version: 1,
    createdAt: input.createdAt ?? new Date().toISOString(),
  });
  ensureWorkEvidenceIgnored(harnessRoot);
  writeRecord(
    hashedRecordPath(harnessRoot, WORK_ATTEMPTS_DIR, attempt.attemptId),
    attempt,
  );
  return attempt;
}

export function listWorkAttempts(harnessRoot: string): WorkAttemptRecord[] {
  return listRecords(harnessRoot, WORK_ATTEMPTS_DIR, (value) =>
    WorkAttemptRecordSchema.parse(value),
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function bindValidationToAttempt(
  harnessRoot: string,
  input: {
    workUnitId: string;
    attemptId: string;
    validation: ValidationRecord;
  },
): ValidationBindingRecord {
  const stableKey = `${input.attemptId}:${input.validation.validationId}`;
  ensureWorkEvidenceIgnored(harnessRoot);
  const existingFile = hashedRecordPath(
    harnessRoot,
    VALIDATION_BINDINGS_DIR,
    stableKey,
  );
  if (fs.existsSync(existingFile)) {
    try {
      return ValidationBindingRecordSchema.parse(
        JSON.parse(fs.readFileSync(existingFile, 'utf8')),
      );
    } catch {
      // Replace an invalid partial record below.
    }
  }
  const binding = ValidationBindingRecordSchema.parse({
    bindingId: crypto.randomUUID(),
    workUnitId: input.workUnitId,
    attemptId: input.attemptId,
    validationId: input.validation.validationId,
    treeHash: input.validation.treeHash,
    createdAt: new Date().toISOString(),
  });
  writeRecord(existingFile, binding);
  return binding;
}

export function listValidationBindings(
  harnessRoot: string,
): ValidationBindingRecord[] {
  return listRecords(harnessRoot, VALIDATION_BINDINGS_DIR, (value) =>
    ValidationBindingRecordSchema.parse(value),
  ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function decideWorkUnitOutcome(
  harnessRoot: string,
  workUnitId: string,
  outcome: WorkUnitOutcome,
): WorkUnitRecord {
  const existing = findWorkUnit(harnessRoot, workUnitId);
  if (!existing) throw new Error(`Unknown work unit: ${workUnitId}`);
  const record = WorkUnitRecordSchema.parse({
    ...existing,
    outcome,
    updatedAt: new Date().toISOString(),
  });
  writeRecord(hashedRecordPath(harnessRoot, WORK_UNITS_DIR, workUnitId), record);
  markDirty(harnessRoot);
  return record;
}
