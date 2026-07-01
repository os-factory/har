import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CURSOR_RULE_RELATIVE_PATH,
  cursorRuleExists,
  getCursorRulePath,
  handleCursorRule,
  isCursorWorkspace,
  scaffoldCursorRule,
} from '../src/harness/cursor-rule';

describe('cursor-rule', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-cursor-rule-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('detects Cursor workspace and rule presence', () => {
    expect(isCursorWorkspace(tmpDir)).toBe(false);
    expect(cursorRuleExists(tmpDir)).toBe(false);

    fs.mkdirSync(path.join(tmpDir, '.cursor'), { recursive: true });
    expect(isCursorWorkspace(tmpDir)).toBe(true);
  });

  it('scaffolds the Cursor rule from template', () => {
    scaffoldCursorRule(tmpDir);

    const rulePath = getCursorRulePath(tmpDir);
    expect(cursorRuleExists(tmpDir)).toBe(true);
    const content = fs.readFileSync(rulePath, 'utf8');
    expect(content).toContain('alwaysApply: true');
    expect(content).toContain('har env verify 1 --full');
    expect(content).toContain('har_run_verification');
    expect(content).toContain('HAR Harness Workflow');
  });

  it('skips when not a Cursor workspace and no existing rule', async () => {
    const wrote = await handleCursorRule({ repoPath: tmpDir, mode: 'init' });
    expect(wrote).toBe(false);
    expect(cursorRuleExists(tmpDir)).toBe(false);
  });

  it('writes without prompting when cursorRule is true', async () => {
    const wrote = await handleCursorRule({ repoPath: tmpDir, cursorRule: true, mode: 'init' });
    expect(wrote).toBe(true);
    expect(cursorRuleExists(tmpDir)).toBe(true);
  });

  it('skips when noCursorRule is set via cursorRule false', async () => {
    fs.mkdirSync(path.join(tmpDir, '.cursor'), { recursive: true });
    const wrote = await handleCursorRule({ repoPath: tmpDir, cursorRule: false, mode: 'init' });
    expect(wrote).toBe(false);
    expect(cursorRuleExists(tmpDir)).toBe(false);
  });

  it('silently refreshes an existing rule on maintain', async () => {
    scaffoldCursorRule(tmpDir);
    const rulePath = getCursorRulePath(tmpDir);
    const before = fs.readFileSync(rulePath, 'utf8');
    fs.writeFileSync(rulePath, before.replace('alwaysApply: true', 'alwaysApply: false'));

    const wrote = await handleCursorRule({ repoPath: tmpDir, mode: 'maintain' });
    expect(wrote).toBe(true);
    expect(fs.readFileSync(rulePath, 'utf8')).toContain('alwaysApply: true');
  });
});
