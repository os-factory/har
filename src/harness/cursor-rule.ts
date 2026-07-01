import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { writeFileSafe } from '../utils/file-ops';
import { info } from '../utils/logging';
import { resolveTemplateFile } from '../utils/paths';

export const CURSOR_RULE_RELATIVE_PATH = '.cursor/rules/har-workflow.mdc';

export function getCursorRulePath(repoPath: string): string {
  return path.join(repoPath, CURSOR_RULE_RELATIVE_PATH);
}

export function isCursorWorkspace(repoPath: string): boolean {
  return fs.existsSync(path.join(repoPath, '.cursor'));
}

export function cursorRuleExists(repoPath: string): boolean {
  return fs.existsSync(getCursorRulePath(repoPath));
}

export function scaffoldCursorRule(repoPath: string): void {
  const templatePath = resolveTemplateFile('cursor-rule.mdc.template');
  if (!templatePath) {
    throw new Error('Cursor rule template not found (cursor-rule.mdc.template). Run npm run build.');
  }

  const content = fs.readFileSync(templatePath, 'utf8');
  writeFileSafe(getCursorRulePath(repoPath), content);
}

export interface CursorRuleScaffoldOptions {
  repoPath: string;
  /** true = force write, false = skip, undefined = auto-detect / prompt */
  cursorRule?: boolean;
  autoYes?: boolean;
  mode: 'init' | 'maintain';
}

export async function handleCursorRule(options: CursorRuleScaffoldOptions): Promise<boolean> {
  const { repoPath, cursorRule, autoYes, mode } = options;

  if (cursorRule === false) {
    return false;
  }

  const exists = cursorRuleExists(repoPath);
  const isCursor = isCursorWorkspace(repoPath);

  if (cursorRule === true || autoYes) {
    scaffoldCursorRule(repoPath);
    info(`Wrote ${CURSOR_RULE_RELATIVE_PATH}`);
    return true;
  }

  if (mode === 'maintain' && exists) {
    scaffoldCursorRule(repoPath);
    info(`Refreshed ${CURSOR_RULE_RELATIVE_PATH}`);
    return true;
  }

  if (!isCursor && !exists) {
    return false;
  }

  const accepted = await promptScaffoldCursorRule(exists);
  if (!accepted) {
    info('Skipped Cursor rule');
    return false;
  }

  scaffoldCursorRule(repoPath);
  info(`Wrote ${CURSOR_RULE_RELATIVE_PATH}`);
  return true;
}

async function promptScaffoldCursorRule(exists: boolean): Promise<boolean> {
  const action = exists ? 'Update' : 'Create';
  return askYesNo(`${action} ${CURSOR_RULE_RELATIVE_PATH}? [Y/n]`);
}

async function askYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    process.stderr.write(`${question} `);
    rl.once('line', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === '') {
        resolve(true);
        return;
      }
      resolve(/^y(es)?$/i.test(trimmed));
    });
  });
}
