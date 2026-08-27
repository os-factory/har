import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import inquirer from 'inquirer';
import {
  AGENTS_MD,
  CLAUDE_MD,
  CLAUDE_HAR_SECTION_END,
  CLAUDE_HAR_SECTION_START,
  HAR_SECTION_END,
  HAR_SECTION_START,
  LEGACY_AGENT_MD,
  buildInstallPlan,
  detectInstructionFiles,
  ensureClaudeMdPointer,
  extractOutsideHarSection,
  formatDetectionReport,
  formatInstallPlan,
  handleInstructionFiles,
  loadHarAgentsSectionFromTemplate,
  mergeAgentsMdContent,
  migrateLegacyAgentMd,
  stripClaudePointerFromAgentsMd,
  upsertAgentsMdHarSection,
} from '../src/harness/instruction-files';
import { writeAgentMdProposal } from '../src/harness/agent-md';
import { maintainHarness } from '../src/core/harness';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';

jest.mock('inquirer', () => ({
  __esModule: true,
  default: { prompt: jest.fn() },
}));

function makeTempRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: prefix }) + '\n');
  return dir;
}

describe('instruction-files', () => {
  it('detects instruction entrypoints', () => {
    const repoPath = makeTempRepo('har-detect');
    fs.writeFileSync(path.join(repoPath, AGENTS_MD), '# hi\n');
    fs.mkdirSync(path.join(repoPath, '.cursor'));
    const detection = detectInstructionFiles(repoPath);
    expect(detection.agentsMd).toBe(true);
    expect(detection.agentMd).toBe(false);
    expect(detection.cursorDir).toBe(true);
    expect(formatDetectionReport(detection)).toContain('AGENTS.md (exists)');
  });

  it('creates AGENTS.md from template with HAR section markers', () => {
    const repoPath = makeTempRepo('har-agents-create');
    const action = upsertAgentsMdHarSection(repoPath);
    expect(action).toBe('created');
    const content = fs.readFileSync(path.join(repoPath, AGENTS_MD), 'utf8');
    expect(content).toContain(HAR_SECTION_START);
    expect(content).toContain('Launch first');
  });

  it('appends HAR section to existing AGENTS.md without wiping content', () => {
    const repoPath = makeTempRepo('har-agents-append');
    fs.writeFileSync(path.join(repoPath, AGENTS_MD), '# Project agents\n\nKeep me.\n');
    const action = upsertAgentsMdHarSection(repoPath);
    expect(action).toBe('appended');
    const content = fs.readFileSync(path.join(repoPath, AGENTS_MD), 'utf8');
    expect(content).toContain('Keep me.');
    expect(content).toContain(HAR_SECTION_START);
  });

  it('updates existing marked HAR section', () => {
    const repoPath = makeTempRepo('har-agents-update');
    fs.writeFileSync(
      path.join(repoPath, AGENTS_MD),
      `# Project\n\n${HAR_SECTION_START}\nold\n<!-- har:agent-environment:end -->\n`,
    );
    const action = upsertAgentsMdHarSection(repoPath);
    expect(action).toBe('updated');
    const content = fs.readFileSync(path.join(repoPath, AGENTS_MD), 'utf8');
    expect(content).toContain('Launch first');
    expect(content).not.toContain('\nold\n');
  });

  it('migrates legacy AGENT.md into AGENTS.md and deletes legacy', () => {
    const repoPath = makeTempRepo('har-migrate');
    fs.writeFileSync(path.join(repoPath, LEGACY_AGENT_MD), '# Legacy guide\n\nUnique note.\n');
    expect(migrateLegacyAgentMd(repoPath)).toBe(true);
    expect(fs.existsSync(path.join(repoPath, LEGACY_AGENT_MD))).toBe(false);
    expect(fs.existsSync(path.join(repoPath, AGENTS_MD))).toBe(true);
    const content = fs.readFileSync(path.join(repoPath, AGENTS_MD), 'utf8');
    expect(content).toContain('Unique note.');
    expect(content).toContain(HAR_SECTION_START);
  });

  // #301: CLAUDE.md holds no content of its own — it imports AGENTS.md so there
  // is exactly one instruction file to keep current.
  it('creates CLAUDE.md as exactly the AGENTS.md import', () => {
    const repoPath = makeTempRepo('har-claude-thin');
    const action = ensureClaudeMdPointer(repoPath);
    expect(action).toBe('created');
    const content = fs.readFileSync(path.join(repoPath, CLAUDE_MD), 'utf8');
    expect(content.trim()).toBe('@AGENTS.md');
  });

  it('replaces a HAR-authored pointer with the import', () => {
    const repoPath = makeTempRepo('har-claude-legacy');
    fs.writeFileSync(
      path.join(repoPath, CLAUDE_MD),
      '# Proj\n\nRead [AGENTS.md](./AGENTS.md) and [.har/README.md](./.har/README.md).\n',
    );
    expect(ensureClaudeMdPointer(repoPath)).toBe('updated');
    expect(fs.readFileSync(path.join(repoPath, CLAUDE_MD), 'utf8').trim()).toBe('@AGENTS.md');
  });

  it("preserves a user's own CLAUDE.md and prepends the import", () => {
    const repoPath = makeTempRepo('har-claude-rich');
    const rich = '# My project\n\n' + 'x'.repeat(700) + '\n\n## Style\nUse tabs.\n';
    fs.writeFileSync(path.join(repoPath, CLAUDE_MD), rich);
    const action = ensureClaudeMdPointer(repoPath);
    expect(action).toBe('appended');
    const content = fs.readFileSync(path.join(repoPath, CLAUDE_MD), 'utf8');
    expect(content.startsWith('@AGENTS.md\n')).toBe(true);
    expect(content).toContain('Use tabs.');
    expect(content).toContain('x'.repeat(700));
    expect(content).not.toContain('Definition of done');
  });

  it('is idempotent — a file that already imports AGENTS.md is untouched', () => {
    const repoPath = makeTempRepo('har-claude-idem');
    const rich = '@AGENTS.md\n\n# Mine\n' + 'y'.repeat(700) + '\n';
    fs.writeFileSync(path.join(repoPath, CLAUDE_MD), rich);
    expect(ensureClaudeMdPointer(repoPath)).toBe('skipped');
    expect(fs.readFileSync(path.join(repoPath, CLAUDE_MD), 'utf8')).toBe(rich);
    expect(ensureClaudeMdPointer(repoPath)).toBe('skipped');
  });

  // #301: the always-loaded block teaches one way to drive the harness. The
  // shell surface appears only for an ejected harness, where the scripts are
  // genuinely the entry point.
  it('the AGENTS.md HAR block is minimal and free of shell entry points', () => {
    const section = loadHarAgentsSectionFromTemplate();
    expect(section.split('\n').length).toBeLessThanOrEqual(25);
    expect(section).not.toMatch(/\.\/\.har\/[a-z-]+\.sh/);
    expect(section).toContain('har env launch');
    expect(section).toContain('.har/README.md');
    expect(section).not.toContain('CLAUDE.agent.md');
  });

  it('an ejected harness gets the shell surface documented', () => {
    const section = loadHarAgentsSectionFromTemplate({ ejected: true });
    expect(section).toContain('./.har/launch.sh <id>');
    expect(section).toContain('har env adopt');
    expect(section.endsWith(HAR_SECTION_END)).toBe(true);
  });

  it('buildInstallPlan always includes AGENTS.md and gates adapters by targets', () => {
    const detection = {
      agentsMd: false,
      agentMd: true,
      claudeMd: false,
      cursorDir: true,
      claudeDir: false,
      codexHome: false,
    };
    const plan = buildInstallPlan(detection, ['claude'], {
      skills: ['claude'],
      respectProviderSelection: true,
    });
    expect(plan.agentsMd).toBe(true);
    expect(plan.migrateLegacyAgentMd).toBe(true);
    expect(plan.claudeMd).toBe(true);
    expect(plan.cursorRule).toBe(false);
    expect(plan.skills).toEqual(['claude']);
    expect(formatInstallPlan(plan, detection)).toContain('[x] Create AGENTS.md');
  });

  it('preselects detected providers and leaves skill installation off by default', async () => {
    const repoPath = makeTempRepo('har-provider-selection');
    fs.mkdirSync(path.join(repoPath, '.claude'));
    fs.mkdirSync(path.join(repoPath, '.cursor'));
    const prompt = inquirer.prompt as unknown as jest.Mock;
    prompt
      .mockResolvedValueOnce({ targets: ['claude', 'cursor'] })
      .mockResolvedValueOnce({ installSkills: false });

    const result = await handleInstructionFiles({ repoPath, mode: 'init' });

    const providerQuestion = prompt.mock.calls[0][0][0];
    expect(providerQuestion.type).toBe('checkbox');
    expect(providerQuestion.choices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: 'claude', checked: true }),
        expect.objectContaining({ value: 'cursor', checked: true }),
        expect.objectContaining({ value: 'codex' }),
      ]),
    );
    const skillsQuestion = prompt.mock.calls[1][0][0];
    expect(skillsQuestion).toEqual(expect.objectContaining({ type: 'confirm', default: false }));
    expect(result.targets).toEqual(['claude', 'cursor']);
    expect(result.plan.skills).toEqual([]);
    expect(result.plan.claudeMd).toBe(true);
    expect(result.plan.cursorRule).toBe(true);
  });

  it('strips misplaced claude-pointer markers from AGENTS.md', () => {
    const repoPath = makeTempRepo('har-strip-claude');
    const content = `# Project\n\n${CLAUDE_HAR_SECTION_START}\nclaude only\n${CLAUDE_HAR_SECTION_END}\n\nKeep me.\n`;
    fs.writeFileSync(path.join(repoPath, AGENTS_MD), content);
    upsertAgentsMdHarSection(repoPath);
    const updated = fs.readFileSync(path.join(repoPath, AGENTS_MD), 'utf8');
    expect(updated).toContain('Keep me.');
    expect(updated).not.toContain('har:claude-pointer');
    expect(updated).toContain(HAR_SECTION_START);
  });

  it('appends HAR section when start marker exists without end marker', () => {
    const repoPath = makeTempRepo('har-orphan-start');
    fs.writeFileSync(
      path.join(repoPath, AGENTS_MD),
      `# Project\n\n${HAR_SECTION_START}\norphaned\n\n## Build\nnpm test\n`,
    );
    const action = upsertAgentsMdHarSection(repoPath);
    expect(action).toBe('appended');
    const content = fs.readFileSync(path.join(repoPath, AGENTS_MD), 'utf8');
    expect(content).toContain('npm test');
    expect(content.match(/har:agent-environment:start/g)?.length).toBe(2);
  });

  it('rejects finalize refresh that would shrink outside-marker content', () => {
    const repoPath = makeTempRepo('har-shrink');
    const outside = Array.from({ length: 20 }, (_, i) => `- item ${i}`).join('\n');
    fs.writeFileSync(
      path.join(repoPath, AGENTS_MD),
      `${outside}\n\n${HAR_SECTION_START}\n${outside}\n${HAR_SECTION_END}\n`,
    );
    expect(() =>
      upsertAgentsMdHarSection(repoPath, { rejectSignificantShrink: true }),
    ).not.toThrow();
    const content = fs.readFileSync(path.join(repoPath, AGENTS_MD), 'utf8');
    expect(content).toContain('- item 0');
    expect(content).toContain('Launch first');
  });

  it('mergeAgentsMdContent preserves project guidance outside managed markers', () => {
    const existing = '# Project\n\n## Build\nnpm run build\n\n';
    const proposal = `# Scaffold\n\n${HAR_SECTION_START}\nnew har\n${HAR_SECTION_END}\n\n## Project\nlost\n`;
    const merged = mergeAgentsMdContent(existing, proposal);
    expect(merged).toContain('npm run build');
    expect(merged).toContain('new har');
    expect(merged).not.toContain('lost');
    expect(extractOutsideHarSection(merged)).toContain('npm run build');
  });

  it('migrateLegacyAgentMd merges legacy notes when AGENTS.md already exists', () => {
    const repoPath = makeTempRepo('har-migrate-both');
    fs.writeFileSync(path.join(repoPath, AGENTS_MD), '# Existing\n\n## Project\nKeep.\n');
    fs.writeFileSync(path.join(repoPath, LEGACY_AGENT_MD), '# Legacy\n\nUnique legacy note.\n');
    expect(migrateLegacyAgentMd(repoPath)).toBe(true);
    const content = fs.readFileSync(path.join(repoPath, AGENTS_MD), 'utf8');
    expect(content).toContain('Keep.');
    expect(content).toContain('Unique legacy note.');
    expect(fs.existsSync(path.join(repoPath, LEGACY_AGENT_MD))).toBe(false);
  });

  it('finalize merges AGENTS.md.proposed without dropping outside-marker content', async () => {
    const repoPath = makeTempRepo('har-finalize-merge');
    fs.writeFileSync(path.join(repoPath, 'package.json'), JSON.stringify({ name: 'app' }) + '\n');
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
    const projectSection = Array.from({ length: 15 }, (_, i) => `## Section ${i}\nDetail ${i}.`).join(
      '\n\n',
    );
    fs.writeFileSync(path.join(repoPath, AGENTS_MD), `# App\n\n${projectSection}\n`);
    writeAgentMdProposal(
      repoPath,
      `# Proposed\n\n${HAR_SECTION_START}\nshould not replace project\n${HAR_SECTION_END}\n`,
      'test proposal',
    );

    await maintainHarness({ repoPath, finalize: true, summary: 'test finalize merge' });

    const content = fs.readFileSync(path.join(repoPath, AGENTS_MD), 'utf8');
    expect(content).toContain('## Section 0');
    expect(content).toContain('Launch first');
    expect(stripClaudePointerFromAgentsMd(content)).toBe(content);
  });
});
