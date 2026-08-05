import * as fs from 'fs';
import * as path from 'path';
import { getAgentSlotRange } from '../harness/stages';
import { getHarnessDir } from '../harness/manifest';

export function requireHarnessDir(repoPath: string): string {
  const harnessDir = getHarnessDir(repoPath);

  if (!fs.existsSync(harnessDir)) {
    throw new Error('No .har/ directory found. Run "har env init" first.');
  }
  return harnessDir;
}

export function formatInvalidAgentIdError(
  id: unknown,
  range: { min: number; max: number },
): string {
  const idLabel =
    id === undefined || id === null || id === ''
      ? '(missing)'
      : typeof id === 'string'
        ? id
        : String(id);
  const lines = [
    `Invalid agent slot id: ${idLabel}`,
    `Valid slots: ${range.min}–${range.max} (configured in .har/stages.json → agentSlots)`,
    'Run `har env status` to see which slots are in use.',
  ];
  const num = Number(id);
  if (Number.isInteger(num) && num > range.max) {
    lines.push(`To allow slot ${num}, raise agentSlots.max in .har/stages.json.`);
  }
  return lines.join('\n');
}

export function validateAgentId(id: unknown, repoPath: string): number {
  const num = Number(id);
  const range = getAgentSlotRange(repoPath);
  if (!Number.isInteger(num) || num < range.min || num > range.max) {
    throw new Error(formatInvalidAgentIdError(id, range));
  }
  return num;
}

export function getHarnessScript(repoPath: string, scriptName: string): string {
  const harnessDir = requireHarnessDir(repoPath);
  const script = path.join(harnessDir, scriptName);
  if (!fs.existsSync(script)) {
    throw new Error(`No ${scriptName} found in .har/. Run "har env init" first.`);
  }
  return script;
}
