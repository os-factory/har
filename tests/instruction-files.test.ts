import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  AGENTS_MD,
  CLAUDE_MD,
  HAR_SECTION_START,
  LEGACY_AGENT_MD,
  buildInstallPlan,
  detectInstructionFiles,
  ensureClaudeMdPointer,
  formatDetectionReport,
  formatInstallPlan,
  migrateLegacyAgentMd,
  upsertAgentsMdHarSection,
} from '../src/harness/instruction-files';

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

  it('creates thin CLAUDE.md pointer to AGENTS.md', () => {
    const repoPath = makeTempRepo('har-claude-thin');
    const action = ensureClaudeMdPointer(repoPath);
    expect(action).toBe('created');
    const content = fs.readFileSync(path.join(repoPath, CLAUDE_MD), 'utf8');
    expect(content).toContain('AGENTS.md');
    expect(content).not.toContain('Launch first');
  });

  it('appends short HAR pointer to rich CLAUDE.md', () => {
    const repoPath = makeTempRepo('har-claude-rich');
    const rich = '# My project\n\n' + 'x'.repeat(700) + '\n\n## Style\nUse tabs.\n';
    fs.writeFileSync(path.join(repoPath, CLAUDE_MD), rich);
    const action = ensureClaudeMdPointer(repoPath);
    expect(action).toBe('appended');
    const content = fs.readFileSync(path.join(repoPath, CLAUDE_MD), 'utf8');
    expect(content).toContain('Use tabs.');
    expect(content).toContain('AGENTS.md');
    expect(content).not.toContain('Definition of done');
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
    const plan = buildInstallPlan(detection, ['claude'], { skillsEnabled: true });
    expect(plan.agentsMd).toBe(true);
    expect(plan.migrateLegacyAgentMd).toBe(true);
    expect(plan.claudeMd).toBe(true);
    expect(plan.cursorRule).toBe(true);
    expect(formatInstallPlan(plan, detection)).toContain('[x] Create AGENTS.md');
  });
});
