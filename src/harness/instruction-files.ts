import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import { writeFileSafe } from '../utils/file-ops';
import { divider, info, success } from '../utils/logging';
import { resolveTemplateFile } from '../utils/paths';
import { AGENT_SKILL_TARGETS, detectAgentTargets, parseAgentTargets } from './agent-skills';
import type { AgentSkillTarget } from './schema';

export const AGENTS_MD = 'AGENTS.md';
export const LEGACY_AGENT_MD = 'AGENT.md';
export const CLAUDE_MD = 'CLAUDE.md';

export const HAR_SECTION_START = '<!-- har:agent-environment:start -->';
export const HAR_SECTION_END = '<!-- har:agent-environment:end -->';

/** Short pointer appended when a rich CLAUDE.md already exists. */
export const CLAUDE_HAR_SECTION_START = '<!-- har:claude-pointer:start -->';
export const CLAUDE_HAR_SECTION_END = '<!-- har:claude-pointer:end -->';

export interface InstructionFileDetection {
  agentsMd: boolean;
  agentMd: boolean;
  claudeMd: boolean;
  cursorDir: boolean;
  claudeDir: boolean;
  codexHome: boolean;
}

export interface InstructionInstallPlan {
  /** Always true when installing project instructions. */
  agentsMd: boolean;
  migrateLegacyAgentMd: boolean;
  claudeMd: boolean;
  cursorRule: boolean;
  skills: AgentSkillTarget[];
}

export interface InstructionFilesOptions {
  repoPath: string;
  /** Comma-separated agent list from --agents; undefined = auto-detect / prompt. */
  agents?: string;
  /** false = --no-agents: skip skills + Claude pointer; still write AGENTS.md. */
  enabled?: boolean;
  /** Tri-state for Cursor rule (passed through from onboarding). */
  cursorRule?: boolean;
  autoYes?: boolean;
  mode: 'init' | 'maintain';
  /**
   * When false, skip creating/updating AGENTS.md (rare). Default true —
   * AGENTS.md is the shared project contract even when skills are skipped.
   */
  writeAgentsMd?: boolean;
}

export interface InstructionFilesResult {
  detection: InstructionFileDetection;
  plan: InstructionInstallPlan;
  targets: AgentSkillTarget[];
  agentsMdAction: 'created' | 'updated' | 'appended' | 'skipped' | null;
  migratedLegacy: boolean;
  claudeMdAction: 'created' | 'updated' | 'appended' | 'skipped' | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function detectInstructionFiles(repoPath: string): InstructionFileDetection {
  return {
    agentsMd: fs.existsSync(path.join(repoPath, AGENTS_MD)),
    agentMd: fs.existsSync(path.join(repoPath, LEGACY_AGENT_MD)),
    claudeMd: fs.existsSync(path.join(repoPath, CLAUDE_MD)),
    cursorDir: fs.existsSync(path.join(repoPath, '.cursor')),
    claudeDir: fs.existsSync(path.join(repoPath, '.claude')),
    codexHome: fs.existsSync(path.join(os.homedir(), '.codex')),
  };
}

export function formatDetectionReport(detection: InstructionFileDetection): string {
  const lines: string[] = ['Detected:'];
  lines.push(`  - ${AGENTS_MD} (${detection.agentsMd ? 'exists' : 'missing'})`);
  if (detection.agentMd) {
    lines.push(`  - ${LEGACY_AGENT_MD} (legacy — will migrate into ${AGENTS_MD})`);
  }
  lines.push(`  - ${CLAUDE_MD} (${detection.claudeMd ? 'exists' : 'missing'})`);
  lines.push(`  - .cursor/ (${detection.cursorDir ? 'exists' : 'missing'})`);
  lines.push(`  - .claude/ (${detection.claudeDir ? 'exists' : 'missing'})`);
  lines.push(`  - ~/.codex (${detection.codexHome ? 'exists' : 'missing'})`);
  return lines.join('\n');
}

export function buildInstallPlan(
  detection: InstructionFileDetection,
  targets: AgentSkillTarget[],
  options: { writeAgentsMd?: boolean; cursorRule?: boolean; skillsEnabled?: boolean } = {},
): InstructionInstallPlan {
  const writeAgentsMd = options.writeAgentsMd !== false;
  const skillsEnabled = options.skillsEnabled !== false;
  const cursorExplicit = options.cursorRule;
  const wantsCursor =
    cursorExplicit === true ||
    (cursorExplicit !== false && (targets.includes('cursor') || detection.cursorDir));

  return {
    agentsMd: writeAgentsMd,
    migrateLegacyAgentMd: writeAgentsMd && detection.agentMd,
    claudeMd: skillsEnabled && targets.includes('claude'),
    cursorRule: wantsCursor,
    skills: skillsEnabled ? targets : [],
  };
}

export function formatInstallPlan(
  plan: InstructionInstallPlan,
  detection: InstructionFileDetection,
): string {
  const mark = (on: boolean) => (on ? '[x]' : '[ ]');
  const lines: string[] = ['After you confirm, HAR will:'];
  const agentsAction = detection.agentsMd
    ? `Update ${AGENTS_MD} — refresh HAR / agent environment section`
    : `Create ${AGENTS_MD} — shared HAR workflow (Codex + cross-tool)`;
  lines.push(`  ${mark(plan.agentsMd)} ${agentsAction}`);
  if (plan.migrateLegacyAgentMd) {
    lines.push(`  ${mark(true)} Migrate ${LEGACY_AGENT_MD} → ${AGENTS_MD}, then remove legacy file`);
  }
  lines.push(
    `  ${mark(plan.claudeMd)} Claude — ensure ${CLAUDE_MD} points at ${AGENTS_MD}; install .claude/skills if confirmed`,
  );
  lines.push(
    `  ${mark(plan.cursorRule)} Cursor — install/refresh .cursor/rules/har-workflow.mdc + commands if confirmed`,
  );
  lines.push(
    `  ${mark(plan.skills.includes('codex'))} Codex — global ~/.codex/prompts (skills); project contract is ${AGENTS_MD}`,
  );
  return lines.join('\n');
}

/** Extract the marked HAR section body from the AGENTS.md template (including markers). */
export function loadHarAgentsSectionFromTemplate(): string {
  const templatePath = resolveTemplateFile('AGENTS.md.template');
  if (!templatePath) {
    throw new Error('AGENTS.md.template not found. Run npm run build.');
  }
  const content = fs.readFileSync(templatePath, 'utf8');
  const start = content.indexOf(HAR_SECTION_START);
  const end = content.indexOf(HAR_SECTION_END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error('AGENTS.md.template is missing har:agent-environment markers.');
  }
  return content.slice(start, end + HAR_SECTION_END.length);
}

export function loadAgentsMdTemplate(): string {
  const templatePath = resolveTemplateFile('AGENTS.md.template');
  if (!templatePath) {
    throw new Error('AGENTS.md.template not found. Run npm run build.');
  }
  return fs.readFileSync(templatePath, 'utf8');
}

function upsertMarkedBlock(
  content: string,
  block: string,
  startMarker: string,
  endMarker: string,
): { content: string; action: 'updated' | 'appended' } {
  if (content.includes(startMarker)) {
    const pattern = new RegExp(
      `${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`,
    );
    return { content: content.replace(pattern, block), action: 'updated' };
  }
  const suffix = content.endsWith('\n') ? '' : '\n';
  return { content: `${content}${suffix}\n${block}\n`, action: 'appended' };
}

/**
 * Create AGENTS.md from template, or upsert the managed HAR section into an existing file.
 */
export function upsertAgentsMdHarSection(repoPath: string): 'created' | 'updated' | 'appended' {
  const dest = path.join(repoPath, AGENTS_MD);
  const section = loadHarAgentsSectionFromTemplate();

  if (!fs.existsSync(dest)) {
    writeFileSafe(dest, loadAgentsMdTemplate());
    return 'created';
  }

  const existing = fs.readFileSync(dest, 'utf8');
  const { content, action } = upsertMarkedBlock(
    existing,
    section,
    HAR_SECTION_START,
    HAR_SECTION_END,
  );
  writeFileSafe(dest, content);
  return action;
}

/**
 * Migrate legacy AGENT.md into AGENTS.md, then delete AGENT.md.
 * Returns true when a migration happened.
 */
export function migrateLegacyAgentMd(repoPath: string): boolean {
  const legacyPath = path.join(repoPath, LEGACY_AGENT_MD);
  const agentsPath = path.join(repoPath, AGENTS_MD);
  if (!fs.existsSync(legacyPath)) return false;

  const legacy = fs.readFileSync(legacyPath, 'utf8');

  if (!fs.existsSync(agentsPath)) {
    writeFileSafe(agentsPath, legacy);
    upsertAgentsMdHarSection(repoPath);
  } else {
    upsertAgentsMdHarSection(repoPath);
  }

  fs.unlinkSync(legacyPath);
  info(`Migrated ${LEGACY_AGENT_MD} → ${AGENTS_MD} (removed legacy file)`);
  return true;
}

function loadClaudeMdTemplate(projectName: string): string {
  const templatePath = resolveTemplateFile('CLAUDE.md.template');
  if (!templatePath) {
    throw new Error('CLAUDE.md.template not found. Run npm run build.');
  }
  const displayName = projectName.replace(/_/g, ' ');
  return fs
    .readFileSync(templatePath, 'utf8')
    .replace(/__PROJECT_DISPLAY_NAME__/g, displayName);
}

function isThinClaudePointer(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length > 600) return false;
  return (
    /AGENTS\.md|AGENT\.md/.test(trimmed) &&
    (trimmed.includes('.har/README.md') || trimmed.includes('har-workflow'))
  );
}

const CLAUDE_POINTER_BLOCK = `${CLAUDE_HAR_SECTION_START}
## HAR

This repository uses a \`.har/\` harness. Read [AGENTS.md](./AGENTS.md) and
[\`.har/README.md\`](./.har/README.md) before making changes.
${CLAUDE_HAR_SECTION_END}`;

/**
 * Ensure CLAUDE.md is a thin pointer to AGENTS.md, or add a short HAR subsection
 * when a rich CLAUDE.md already exists. Never paste the full workflow.
 */
export function ensureClaudeMdPointer(
  repoPath: string,
  options: { force?: boolean } = {},
): 'created' | 'updated' | 'appended' | 'skipped' {
  const dest = path.join(repoPath, CLAUDE_MD);
  const projectName = path.basename(repoPath).toLowerCase().replace(/[^a-z0-9]/g, '_');
  const thin = loadClaudeMdTemplate(projectName);

  if (!fs.existsSync(dest)) {
    writeFileSafe(dest, thin);
    return 'created';
  }

  const existing = fs.readFileSync(dest, 'utf8');

  if (isThinClaudePointer(existing) || options.force) {
    writeFileSafe(dest, thin);
    return 'updated';
  }

  if (existing.includes(CLAUDE_HAR_SECTION_START) || /\[AGENTS\.md\]/.test(existing)) {
    if (existing.includes(CLAUDE_HAR_SECTION_START)) {
      const { content, action } = upsertMarkedBlock(
        existing,
        CLAUDE_POINTER_BLOCK,
        CLAUDE_HAR_SECTION_START,
        CLAUDE_HAR_SECTION_END,
      );
      writeFileSafe(dest, content);
      return action;
    }
    return 'skipped';
  }

  const { content, action } = upsertMarkedBlock(
    existing,
    CLAUDE_POINTER_BLOCK,
    CLAUDE_HAR_SECTION_START,
    CLAUDE_HAR_SECTION_END,
  );
  writeFileSafe(dest, content);
  return action;
}

async function askYesNo(question: string, defaultYes = true): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    process.stderr.write(`${question} `);
    rl.once('line', (answer) => {
      rl.close();
      const trimmed = answer.trim();
      if (trimmed === '') {
        resolve(defaultYes);
        return;
      }
      resolve(/^y(es)?$/i.test(trimmed));
    });
  });
}

/**
 * Detect instruction files, print findings + install plan, optionally confirm targets,
 * then write AGENTS.md (always), migrate AGENT.md, and ensure CLAUDE.md when Claude is selected.
 *
 * Cursor rule and skill scaffolding remain in their dedicated handlers — this function
 * returns the resolved targets/plan so callers can pass them through.
 */
export async function handleInstructionFiles(
  options: InstructionFilesOptions,
): Promise<InstructionFilesResult> {
  const { repoPath, mode } = options;
  const writeAgentsMd = options.writeAgentsMd !== false;
  const skillsEnabled = options.enabled !== false;
  const detection = detectInstructionFiles(repoPath);

  let targets: AgentSkillTarget[];
  if (!skillsEnabled) {
    targets = [];
  } else if (typeof options.agents === 'string') {
    targets = parseAgentTargets(options.agents);
  } else {
    targets = detectAgentTargets(repoPath);
  }

  // Interactive init with no signals: offer all targets in the confirm prompt.
  // --yes with nothing detected skips skills (still writes AGENTS.md).
  if (
    skillsEnabled &&
    targets.length === 0 &&
    mode === 'init' &&
    typeof options.agents !== 'string' &&
    !options.autoYes
  ) {
    targets = [...AGENT_SKILL_TARGETS];
  }

  let plan = buildInstallPlan(detection, targets, {
    writeAgentsMd,
    cursorRule: options.cursorRule,
    skillsEnabled,
  });

  divider();
  process.stderr.write(`${formatDetectionReport(detection)}\n\n`);
  process.stderr.write(`${formatInstallPlan(plan, detection)}\n`);
  divider();

  const shouldPrompt =
    !options.autoYes &&
    skillsEnabled &&
    typeof options.agents !== 'string' &&
    !(mode === 'maintain' && targets.length > 0 && !detection.agentMd);

  if (shouldPrompt && targets.length > 0) {
    const accepted = await askYesNo(
      `Install HAR agent instructions for: ${targets.join(', ')}? [Y/n]`,
    );
    if (!accepted) {
      info('Skipped agent instruction adapters (AGENTS.md will still be updated)');
      targets = [];
      plan = buildInstallPlan(detection, targets, {
        writeAgentsMd,
        cursorRule: options.cursorRule === true ? true : false,
        skillsEnabled: false,
      });
    }
  }

  let migratedLegacy = false;
  let agentsMdAction: InstructionFilesResult['agentsMdAction'] = null;
  let claudeMdAction: InstructionFilesResult['claudeMdAction'] = null;

  if (writeAgentsMd) {
    if (detection.agentMd) {
      migratedLegacy = migrateLegacyAgentMd(repoPath);
    }
    agentsMdAction = upsertAgentsMdHarSection(repoPath);

    if (agentsMdAction === 'created') {
      success(`Wrote ${AGENTS_MD}`);
    } else if (agentsMdAction === 'updated' || agentsMdAction === 'appended') {
      info(
        `${agentsMdAction === 'updated' ? 'Refreshed' : 'Appended'} HAR section in ${AGENTS_MD}`,
      );
    }
  } else {
    agentsMdAction = 'skipped';
  }

  if (plan.claudeMd) {
    claudeMdAction = ensureClaudeMdPointer(repoPath);
    if (claudeMdAction === 'created') {
      success(`Wrote ${CLAUDE_MD} (pointer → ${AGENTS_MD})`);
    } else if (claudeMdAction === 'updated' || claudeMdAction === 'appended') {
      info(
        `${claudeMdAction === 'updated' ? 'Updated' : 'Appended'} ${CLAUDE_MD} pointer → ${AGENTS_MD}`,
      );
    }
  } else {
    claudeMdAction = 'skipped';
  }

  return {
    detection,
    plan,
    targets,
    agentsMdAction,
    migratedLegacy,
    claudeMdAction,
  };
}
