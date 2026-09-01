import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  ValidationCommitBinding,
  ValidationCommitBindingSchema,
} from '../harness/schema';
import { markDirty } from './sync-context';

export const COMMIT_BINDINGS_DIR = 'commit-bindings';

export interface RecordCommitBindingInput {
  harnessRoot: string;
  validationId: string;
  treeHash: string;
  commitSha: string;
  parents?: string[];
  refs?: string[];
  message?: string;
  runId?: string;
}

function bindingsDir(harnessRoot: string): string {
  return path.join(harnessRoot, '.har', COMMIT_BINDINGS_DIR);
}

function bindingPath(harnessRoot: string, treeHash: string, commitSha: string): string {
  const digest = crypto.createHash('sha256').update(`${treeHash}:${commitSha}`).digest('hex');
  return path.join(bindingsDir(harnessRoot), `${digest}.json`);
}

function writeBinding(file: string, binding: ValidationCommitBinding): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(binding, null, 2)}\n`);
  fs.renameSync(temp, file);
}

export function ensureCommitBindingsIgnored(harnessRoot: string): void {
  const harDir = path.join(harnessRoot, '.har');
  if (!fs.existsSync(harDir)) return;
  const gitignorePath = path.join(harDir, '.gitignore');
  const content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  if (content.split('\n').some((line) => line.trim() === `${COMMIT_BINDINGS_DIR}/`)) return;
  const suffix = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  fs.writeFileSync(gitignorePath, `${content}${suffix}${COMMIT_BINDINGS_DIR}/\n`);
}

/**
 * Record that a commit's tree matches a validation. Same tree + different
 * commits (rebase, cherry-pick) produce additional bindings instead of
 * overwriting the first association.
 */
export function recordCommitBinding(input: RecordCommitBindingInput): ValidationCommitBinding {
  ensureCommitBindingsIgnored(input.harnessRoot);
  const file = bindingPath(input.harnessRoot, input.treeHash, input.commitSha);
  if (fs.existsSync(file)) {
    try {
      return ValidationCommitBindingSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch {
      // Replace an invalid partial record below.
    }
  }

  const binding = ValidationCommitBindingSchema.parse({
    bindingId: crypto.randomUUID(),
    validationId: input.validationId,
    treeHash: input.treeHash,
    commitSha: input.commitSha,
    parents: input.parents ?? [],
    refs: input.refs ?? [],
    message: input.message,
    runId: input.runId,
    createdAt: new Date().toISOString(),
  });
  writeBinding(file, binding);
  markDirty(input.harnessRoot);
  return binding;
}

export function listCommitBindings(harnessRoot: string): ValidationCommitBinding[] {
  const dir = bindingsDir(harnessRoot);
  if (!fs.existsSync(dir)) return [];
  const records: ValidationCommitBinding[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    try {
      records.push(
        ValidationCommitBindingSchema.parse(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))),
      );
    } catch {
      // skip unreadable records
    }
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
