import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import inquirer from 'inquirer';
import { writeFileSafe } from '../utils/file-ops';
import { divider, info, success, warn } from '../utils/logging';
import { resolveTemplateFile } from '../utils/paths';
import { AGENT_SKILL_TARGETS, detectAgentTargets, parseAgentTargets } from './agent-skills';
import { readManifest } from './manifest';
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
  providers: AgentSkillTarget[];
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
  /**
   * When true (har env maintain --finalize), refuse updates that would drop
   * project-specific content outside har:agent-environment markers.
   */
  finalize?: boolean;
}

export interface UpsertAgentsMdOptions {
  /** Throw when outside-marker content would shrink significantly. */
  rejectSignificantShrink?: boolean;
  /** Minimum fraction of non-empty outside-marker lines to preserve (default 0.9). */
  minOutsidePreservationRatio?: number;
}

export class AgentsMdShrinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentsMdShrinkError';
  }
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

function countNonEmptyLines(text: string): number {
  return text.split('\n').filter((line) => line.trim().length > 0).length;
}

/** Remove CLAUDE-only pointer markers if they were copied into AGENTS.md by mistake. */
export function stripClaudePointerFromAgentsMd(content: string): string {
  if (!content.includes(CLAUDE_HAR_SECTION_START)) return content;
  const pattern = new RegExp(
    `${escapeRegExp(CLAUDE_HAR_SECTION_START)}[\\s\\S]*?${escapeRegExp(CLAUDE_HAR_SECTION_END)}\\n?`,
    'g',
  );
  return content.replace(pattern, '').replace(/\n{3,}/g, '\n\n');
}

/** Content outside the managed har:agent-environment block (project-specific guidance). */
export function extractOutsideHarSection(content: string): string {
  const sanitized = stripClaudePointerFromAgentsMd(content);
  return removeCompleteMarkedBlocks(sanitized, HAR_SECTION_START, HAR_SECTION_END).trim();
}

function findLastCompleteMarkedBlock(
  content: string,
  startMarker: string,
  endMarker: string,
): { start: number; end: number } | null {
  let last: { start: number; end: number } | null = null;
  let searchFrom = 0;

  while (searchFrom < content.length) {
    const start = content.indexOf(startMarker, searchFrom);
    if (start === -1) break;
    const end = content.indexOf(endMarker, start + startMarker.length);
    if (end === -1) break;
    const nestedStart = content.indexOf(startMarker, start + startMarker.length);
    if (nestedStart !== -1 && nestedStart < end) {
      searchFrom = start + startMarker.length;
      continue;
    }
    last = { start, end: end + endMarker.length };
    searchFrom = end + endMarker.length;
  }

  return last;
}

function removeCompleteMarkedBlocks(content: string, startMarker: string, endMarker: string): string {
  let result = content;
  let block = findLastCompleteMarkedBlock(result, startMarker, endMarker);
  while (block) {
    result = result.slice(0, block.start) + result.slice(block.end);
    block = findLastCompleteMarkedBlock(result, startMarker, endMarker);
  }
  return result;
}

export function checkOutsideContentPreserved(
  before: string,
  after: string,
  options: UpsertAgentsMdOptions,
): 'ok' | 'shrink' {
  const outsideBefore = extractOutsideHarSection(before);
  const outsideAfter = extractOutsideHarSection(after);
  const beforeLines = countNonEmptyLines(outsideBefore);
  const afterLines = countNonEmptyLines(outsideAfter);
  const minRatio = options.minOutsidePreservationRatio ?? 0.9;

  if (beforeLines >= 5 && afterLines < beforeLines * minRatio) {
    return 'shrink';
  }
  return 'ok';
}

function outsideContentShrinkMessage(beforeLines: number, afterLines: number): string {
  return (
    `Refusing to update ${AGENTS_MD}: refresh would drop project-specific content outside ` +
    `har:agent-environment markers (${beforeLines} → ${afterLines} non-empty lines). ` +
    `Keep custom sections outside those markers, or merge manually before --finalize.`
  );
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
  options: {
    writeAgentsMd?: boolean;
    cursorRule?: boolean;
    skills?: AgentSkillTarget[];
    respectProviderSelection?: boolean;
  } = {},
): InstructionInstallPlan {
  const writeAgentsMd = options.writeAgentsMd !== false;
  const cursorExplicit = options.cursorRule;
  const wantsCursor =
    cursorExplicit === true ||
    (cursorExplicit !== false &&
      (targets.includes('cursor') ||
        (!options.respectProviderSelection && detection.cursorDir)));

  return {
    agentsMd: writeAgentsMd,
    migrateLegacyAgentMd: writeAgentsMd && detection.agentMd,
    providers: targets,
    claudeMd: targets.includes('claude'),
    cursorRule: wantsCursor,
    skills: options.skills ?? [],
  };
}

export function formatInstallPlan(
  plan: InstructionInstallPlan,
  detection: InstructionFileDetection,
): string {
  const mark = (on: boolean) => (on ? '[x]' : '[ ]');
  const lines: string[] = ['HAR will:'];
  const agentsAction = detection.agentsMd
    ? `Update ${AGENTS_MD} — refresh HAR / agent environment section`
    : `Create ${AGENTS_MD} — shared HAR workflow (Codex + cross-tool)`;
  lines.push(`  ${mark(plan.agentsMd)} ${agentsAction}`);
  if (plan.migrateLegacyAgentMd) {
    lines.push(`  ${mark(true)} Migrate ${LEGACY_AGENT_MD} → ${AGENTS_MD}, then remove legacy file`);
  }
  lines.push(
    `  ${mark(plan.claudeMd)} Claude — ensure ${CLAUDE_MD} points at ${AGENTS_MD}`,
  );
  lines.push(
    `  ${mark(plan.cursorRule)} Cursor — install/refresh .cursor/rules/har-workflow.mdc`,
  );
  lines.push(
    `  ${mark(plan.providers.includes('codex'))} Codex — use ${AGENTS_MD} as the project contract`,
  );
  lines.push(
    `  ${mark(plan.skills.length > 0)} Skills — ${
      plan.skills.length > 0 ? `install for ${plan.skills.join(', ')}` : 'do not install'
    }`,
  );
  return lines.join('\n');
}

/**
 * Ejected harnesses vendor the runtime; invocation is still CLI/MCP (or
 * `node .har/runtime/har.cjs env …` with no `har` install). No wrapper scripts.
 */
const HAR_EJECTED_SHELL_SECTION = `
### Ejected harness

This harness is **ejected** (\`har env eject\`): the runtime is vendored in
\`.har/runtime/\`. Drive it with \`har env …\` or
\`node .har/runtime/har.cjs env …\` (no \`har\` install required).

You own \`.har/runtime/\` — HAR will not update it. Return to the packaged
runtime with \`har env adopt\`.
`;

/** Extract the marked HAR section body from the AGENTS.md template (including markers). */
export function loadHarAgentsSectionFromTemplate(
  options: { ejected?: boolean } = {},
): string {
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
  const section = content.slice(start, end + HAR_SECTION_END.length);
  if (!options.ejected) return section;
  return section.replace(
    HAR_SECTION_END,
    `${HAR_EJECTED_SHELL_SECTION}${HAR_SECTION_END}`,
  );
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
  const existingBlock = findLastCompleteMarkedBlock(content, startMarker, endMarker);
  if (existingBlock) {
    const newContent =
      content.slice(0, existingBlock.start) + block + content.slice(existingBlock.end);
    return { content: newContent, action: 'updated' };
  }
  const suffix = content.endsWith('\n') ? '' : '\n';
  return { content: `${content}${suffix}\n${block}\n`, action: 'appended' };
}

/**
 * Merge incoming AGENTS.md content into an existing file — refresh only the managed
 * HAR section; preserve all other project-specific guidance.
 */
export function mergeAgentsMdContent(
  existing: string,
  incoming: string,
  options: { ejected?: boolean } = {},
): string {
  const sanitizedExisting = stripClaudePointerFromAgentsMd(existing);
  const sanitizedIncoming = stripClaudePointerFromAgentsMd(incoming);

  let harSection = loadHarAgentsSectionFromTemplate(options);
  if (sanitizedIncoming.includes(HAR_SECTION_START)) {
    const start = sanitizedIncoming.indexOf(HAR_SECTION_START);
    const end = sanitizedIncoming.indexOf(HAR_SECTION_END, start + HAR_SECTION_START.length);
    if (end !== -1) {
      harSection = sanitizedIncoming.slice(start, end + HAR_SECTION_END.length);
    }
  }

  const { content } = upsertMarkedBlock(
    sanitizedExisting,
    harSection,
    HAR_SECTION_START,
    HAR_SECTION_END,
  );
  return content;
}

/**
 * Create AGENTS.md from template, or upsert the managed HAR section into an existing file.
 */
export function upsertAgentsMdHarSection(
  repoPath: string,
  options: UpsertAgentsMdOptions = {},
): 'created' | 'updated' | 'appended' | 'skipped' {
  const dest = path.join(repoPath, AGENTS_MD);
  const ejected = readManifest(repoPath)?.ejected === true;
  const section = loadHarAgentsSectionFromTemplate({ ejected });

  if (!fs.existsSync(dest)) {
    writeFileSafe(dest, loadAgentsMdTemplate());
    return 'created';
  }

  const existing = fs.readFileSync(dest, 'utf8');
  const sanitized = stripClaudePointerFromAgentsMd(existing);
  const { content, action } = upsertMarkedBlock(
    sanitized,
    section,
    HAR_SECTION_START,
    HAR_SECTION_END,
  );

  if (checkOutsideContentPreserved(existing, content, options) === 'shrink') {
    const beforeLines = countNonEmptyLines(extractOutsideHarSection(existing));
    const afterLines = countNonEmptyLines(extractOutsideHarSection(content));
    const message = outsideContentShrinkMessage(beforeLines, afterLines);
    if (options.rejectSignificantShrink) {
      throw new AgentsMdShrinkError(message);
    }
    warn(message);
    return 'skipped';
  }

  if (content === existing) {
    return 'skipped';
  }

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
    const agents = fs.readFileSync(agentsPath, 'utf8');
    const legacyTrimmed = legacy.trim();
    if (legacyTrimmed.length > 0 && !agents.includes(legacyTrimmed)) {
      const suffix = agents.endsWith('\n') ? '' : '\n';
      writeFileSafe(agentsPath, `${agents}${suffix}\n${legacyTrimmed}\n`);
    }
    upsertAgentsMdHarSection(repoPath);
  }

  fs.unlinkSync(legacyPath);
  info(`Migrated ${LEGACY_AGENT_MD} → ${AGENTS_MD} (removed legacy file)`);
  return true;
}

/**
 * CLAUDE.md carries no content of its own (#301): `AGENTS.md` is the
 * cross-vendor instruction file, and Claude Code reaches it through an `@`
 * import. One source of truth, one file to keep current.
 */
export const CLAUDE_MD_IMPORT = '@AGENTS.md';

function loadClaudeMdTemplate(): string {
  const templatePath = resolveTemplateFile('CLAUDE.md.template');
  if (!templatePath) {
    throw new Error('CLAUDE.md.template not found. Run npm run build.');
  }
  return fs.readFileSync(templatePath, 'utf8');
}

/** True when the file is HAR's own pointer (ours to replace), not the user's work. */
function isHarOwnedClaudeMd(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed === CLAUDE_MD_IMPORT) return true;
  if (trimmed.length > 600) return false;
  return (
    /AGENTS\.md|AGENT\.md/.test(trimmed) &&
    (trimmed.includes('.har/README.md') || trimmed.includes('har-workflow'))
  );
}

/** An `@AGENTS.md` import on its own line, ignoring code fences and inline text. */
function hasAgentsImport(content: string): boolean {
  return content.split('\n').some((line) => line.trim() === CLAUDE_MD_IMPORT);
}

/**
 * Ensure CLAUDE.md pulls AGENTS.md into context.
 *
 * - absent, or a HAR-authored pointer → the file becomes exactly `@AGENTS.md`
 * - hand-written by the user → content preserved verbatim, the import prepended
 *   when missing. HAR never destroys project-specific Claude instructions.
 *
 * Idempotent: a file that already imports AGENTS.md is left alone.
 */
export function ensureClaudeMdPointer(
  repoPath: string,
  options: { force?: boolean } = {},
): 'created' | 'updated' | 'appended' | 'skipped' {
  const dest = path.join(repoPath, CLAUDE_MD);
  const thin = loadClaudeMdTemplate();

  if (!fs.existsSync(dest)) {
    writeFileSafe(dest, thin);
    return 'created';
  }

  const existing = fs.readFileSync(dest, 'utf8');

  if (isHarOwnedClaudeMd(existing) || options.force) {
    if (existing.trim() === CLAUDE_MD_IMPORT) return 'skipped';
    writeFileSafe(dest, thin);
    return 'updated';
  }

  // The user's own CLAUDE.md: keep every line, just make sure AGENTS.md loads.
  if (hasAgentsImport(existing)) return 'skipped';
  writeFileSafe(dest, `${CLAUDE_MD_IMPORT}\n\n${existing.replace(/^\n+/, '')}`);
  return 'appended';
}

async function selectAgentProviders(
  detectedTargets: AgentSkillTarget[],
): Promise<AgentSkillTarget[]> {
  const answers = await inquirer.prompt<{ targets: AgentSkillTarget[] }>([
    {
      type: 'checkbox',
      name: 'targets',
      message: 'Agent providers to configure (space to toggle, enter to confirm)',
      choices: AGENT_SKILL_TARGETS.map((target) => ({
        name: target,
        value: target,
        checked: detectedTargets.includes(target),
      })),
    },
  ]);
  return AGENT_SKILL_TARGETS.filter((target) => answers.targets.includes(target));
}

async function confirmSkillInstallation(targets: AgentSkillTarget[]): Promise<boolean> {
  const answers = await inquirer.prompt<{ installSkills: boolean }>([
    {
      type: 'confirm',
      name: 'installSkills',
      message: `Install HAR skills for ${targets.join(', ')}?`,
      default: false,
    },
  ]);
  return answers.installSkills;
}

/**
 * Detect instruction files, let the user select providers, optionally install skills,
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
  const integrationsEnabled = options.enabled !== false;
  const detection = detectInstructionFiles(repoPath);
  const detectedTargets = detectAgentTargets(repoPath);
  const explicitTargets = typeof options.agents === 'string';

  divider();
  process.stderr.write(`${formatDetectionReport(detection)}\n\n`);

  let targets: AgentSkillTarget[];
  if (!integrationsEnabled) {
    targets = [];
  } else if (explicitTargets) {
    targets = parseAgentTargets(options.agents!);
  } else if (mode === 'init' && !options.autoYes) {
    targets = await selectAgentProviders(detectedTargets);
  } else {
    targets = detectedTargets;
  }

  let skillTargets: AgentSkillTarget[] = [];
  if (explicitTargets) {
    skillTargets = targets;
  } else if (targets.length > 0 && mode === 'init' && !options.autoYes) {
    if (await confirmSkillInstallation(targets)) {
      skillTargets = targets;
    }
  } else if (mode === 'maintain') {
    const scaffoldedTargets = new Set(
      (readManifest(repoPath)?.scaffoldedAgentFiles ?? []).map((entry) => entry.agent),
    );
    skillTargets = targets.filter((target) => scaffoldedTargets.has(target));
  }

  const plan = buildInstallPlan(detection, targets, {
    writeAgentsMd,
    cursorRule: options.cursorRule,
    skills: skillTargets,
    respectProviderSelection:
      integrationsEnabled && (explicitTargets || (mode === 'init' && !options.autoYes)),
  });

  process.stderr.write(`${formatInstallPlan(plan, detection)}\n`);
  divider();

  let migratedLegacy = false;
  let agentsMdAction: InstructionFilesResult['agentsMdAction'] = null;
  let claudeMdAction: InstructionFilesResult['claudeMdAction'] = null;

  if (writeAgentsMd) {
    if (detection.agentMd) {
      migratedLegacy = migrateLegacyAgentMd(repoPath);
    }
    agentsMdAction = upsertAgentsMdHarSection(repoPath, {
      rejectSignificantShrink: options.finalize === true,
    });

    if (agentsMdAction === 'created') {
      success(`Wrote ${AGENTS_MD}`);
    } else if (agentsMdAction === 'updated' || agentsMdAction === 'appended') {
      info(
        `${agentsMdAction === 'updated' ? 'Refreshed' : 'Appended'} HAR section in ${AGENTS_MD}`,
      );
    } else if (agentsMdAction === 'skipped' && options.finalize) {
      warn(
        `${AGENTS_MD} left unchanged — project-specific content outside har:agent-environment markers was preserved.`,
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
