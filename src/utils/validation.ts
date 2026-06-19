import * as fs from 'fs';
import * as path from 'path';
import { getAgentSlotRange } from '../harness/stages';
import { getHarnessDir } from '../harness/manifest';

export function requireApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set.\n' +
        'Get your key at https://console.anthropic.com and run:\n' +
        '  export ANTHROPIC_API_KEY=your_key_here',
    );
  }
  return key;
}

export function requireHarnessDir(repoPath: string): string {
  const harnessDir = getHarnessDir(repoPath);

  if (!fs.existsSync(harnessDir)) {
    throw new Error('No .har/ directory found. Run "har env init" first.');
  }
  return harnessDir;
}

export function validateAgentId(id: unknown, repoPath: string): number {
  const num = Number(id);
  const range = getAgentSlotRange(repoPath);
  if (!Number.isInteger(num) || num < range.min || num > range.max) {
    throw new Error(`agent-id must be a number between ${range.min} and ${range.max}`);
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
