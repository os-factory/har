import * as fs from 'fs';
import * as path from 'path';
import { resolveTemplateFile } from '../utils/paths';

export const CLAUDE_GUARD_RELATIVE_PATH = '.har/hooks/claude-worktree-guard.sh';
const CLAUDE_SETTINGS_RELATIVE_PATH = '.claude/settings.json';
const GUARD_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const GUARD_COMMAND = `"$CLAUDE_PROJECT_DIR"/${CLAUDE_GUARD_RELATIVE_PATH}`;

interface ClaudeHookEntry {
  type: string;
  command: string;
  [key: string]: unknown;
}

interface ClaudeHookMatcher {
  matcher?: string;
  hooks?: ClaudeHookEntry[];
  [key: string]: unknown;
}

type ClaudeSettings = {
  hooks?: Record<string, ClaudeHookMatcher[]>;
  [key: string]: unknown;
};

function isHarGuardEntry(entry: ClaudeHookMatcher): boolean {
  return (entry.hooks ?? []).some(
    (hook) => typeof hook.command === 'string' && hook.command.includes('claude-worktree-guard.sh'),
  );
}

function readSettings(settingsPath: string): ClaudeSettings {
  if (!fs.existsSync(settingsPath)) return {};
  const raw = fs.readFileSync(settingsPath, 'utf8').trim();
  if (raw === '') return {};
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${settingsPath} is not a JSON object — fix it before installing the guard.`);
  }
  return parsed as ClaudeSettings;
}

function writeSettings(settingsPath: string, settings: ClaudeSettings): void {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

export interface ClaudeGuardResult {
  guardScript: string;
  settingsPath: string;
}

/** Install the Claude Code worktree guard: worker script + PreToolUse entry in .claude/settings.json. */
export function installClaudeGuard(repoPath: string): ClaudeGuardResult {
  const templatePath = resolveTemplateFile('claude-worktree-guard.sh.template');
  if (!templatePath) {
    throw new Error('Guard template not found (claude-worktree-guard.sh.template). Run npm run build.');
  }

  const guardScript = path.join(repoPath, CLAUDE_GUARD_RELATIVE_PATH);
  fs.mkdirSync(path.dirname(guardScript), { recursive: true });
  fs.copyFileSync(templatePath, guardScript);
  fs.chmodSync(guardScript, 0o755);

  const settingsPath = path.join(repoPath, CLAUDE_SETTINGS_RELATIVE_PATH);
  const settings = readSettings(settingsPath);
  const hooks = settings.hooks ?? {};
  const preToolUse = (hooks.PreToolUse ?? []).filter((entry) => !isHarGuardEntry(entry));
  preToolUse.push({
    matcher: GUARD_MATCHER,
    hooks: [{ type: 'command', command: GUARD_COMMAND }],
  });
  settings.hooks = { ...hooks, PreToolUse: preToolUse };
  writeSettings(settingsPath, settings);

  return { guardScript, settingsPath };
}

export function uninstallClaudeGuard(repoPath: string): { removed: boolean } {
  let removed = false;

  const guardScript = path.join(repoPath, CLAUDE_GUARD_RELATIVE_PATH);
  if (fs.existsSync(guardScript)) {
    fs.rmSync(guardScript);
    removed = true;
    const parent = path.dirname(guardScript);
    if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
  }

  const settingsPath = path.join(repoPath, CLAUDE_SETTINGS_RELATIVE_PATH);
  if (fs.existsSync(settingsPath)) {
    const settings = readSettings(settingsPath);
    const preToolUse = settings.hooks?.PreToolUse;
    if (preToolUse) {
      const filtered = preToolUse.filter((entry) => !isHarGuardEntry(entry));
      if (filtered.length !== preToolUse.length) {
        removed = true;
        if (filtered.length > 0) {
          settings.hooks = { ...settings.hooks, PreToolUse: filtered };
        } else {
          const rest = { ...settings.hooks };
          delete rest.PreToolUse;
          if (Object.keys(rest).length > 0) {
            settings.hooks = rest;
          } else {
            delete settings.hooks;
          }
        }
        writeSettings(settingsPath, settings);
      }
    }
  }

  return { removed };
}

export function claudeGuardInstalled(repoPath: string): boolean {
  const settingsPath = path.join(repoPath, CLAUDE_SETTINGS_RELATIVE_PATH);
  if (!fs.existsSync(settingsPath)) return false;
  try {
    const settings = readSettings(settingsPath);
    return (settings.hooks?.PreToolUse ?? []).some(isHarGuardEntry);
  } catch {
    return false;
  }
}
