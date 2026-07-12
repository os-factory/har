import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MANAGED_HEADER,
  detectAgentTargets,
  parseAgentTargets,
  removeAgentSkills,
  renderSkillFiles,
  scaffoldAgentSkills,
} from '../src/harness/agent-skills';
import { readManifest } from '../src/harness/manifest';

jest.mock('os', () => ({
  ...jest.requireActual('os'),
  homedir: jest.fn(() => jest.requireActual('os').homedir()),
}));

const SKILL_IDS = ['setup-har', 'har-wt', 'har-maintain'];

function writeHarnessManifest(repoPath: string): void {
  fs.mkdirSync(path.join(repoPath, '.har'), { recursive: true });
  fs.writeFileSync(
    path.join(repoPath, '.har', 'manifest.json'),
    JSON.stringify({
      version: '1',
      generatorVersion: '0.4.0',
      outputDir: '.har',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
}

describe('agent-skills', () => {
  let tmpDir: string;
  let tmpHome: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-agent-skills-'));
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'har-agent-skills-home-'));
    (os.homedir as jest.Mock).mockReturnValue(tmpHome);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('renders all three skills for each target', () => {
    const files = renderSkillFiles(['claude', 'cursor', 'codex']);
    expect(files).toHaveLength(9);

    for (const id of SKILL_IDS) {
      const claude = files.find((f) => f.agent === 'claude' && f.skill === id);
      expect(claude?.relPath).toBe(path.join('.claude', 'skills', id, 'SKILL.md'));
      expect(claude?.content).toMatch(/^---\n/);
      expect(claude?.content).toContain('description:');
      expect(claude?.content).toContain(MANAGED_HEADER);

      const cursor = files.find((f) => f.agent === 'cursor' && f.skill === id);
      expect(cursor?.relPath).toBe(path.join('.cursor', 'commands', `${id}.md`));

      const codex = files.find((f) => f.agent === 'codex' && f.skill === id);
      expect(codex?.scope).toBe('global');
      expect(codex?.relPath).toContain('.codex/prompts/');
    }
  });

  it('setup-har and har-maintain are user-invocable only; har-wt is model-invocable', () => {
    const files = renderSkillFiles(['claude']);
    const byId = (id: string) => files.find((f) => f.skill === id)!.content;
    expect(byId('setup-har')).toContain('disable-model-invocation: true');
    expect(byId('har-maintain')).toContain('disable-model-invocation: true');
    expect(byId('har-wt')).not.toContain('disable-model-invocation');
    expect(byId('har-wt')).toContain('BEFORE making any code change');
  });

  it('scaffolds files, records them in the harness manifest, and is idempotent', () => {
    writeHarnessManifest(tmpDir);

    const first = scaffoldAgentSkills(tmpDir, ['claude', 'cursor']);
    expect(first.written).toHaveLength(6);
    expect(first.skipped).toHaveLength(0);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'har-wt', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.cursor', 'commands', 'setup-har.md'))).toBe(true);

    const manifest = readManifest(tmpDir);
    expect(manifest?.scaffoldedAgentFiles).toHaveLength(6);

    const second = scaffoldAgentSkills(tmpDir, ['claude', 'cursor']);
    expect(second.written).toHaveLength(6);
    expect(readManifest(tmpDir)?.scaffoldedAgentFiles).toHaveLength(6);
  });

  it('writes codex prompts globally under ~/.codex/prompts', () => {
    scaffoldAgentSkills(tmpDir, ['codex']);
    expect(fs.existsSync(path.join(tmpHome, '.codex', 'prompts', 'har-wt.md'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, '.codex', 'prompts', 'har-setup.md'))).toBe(true);
  });

  it('skips user-modified files unless forced', () => {
    const skillPath = path.join(tmpDir, '.claude', 'skills', 'har-wt', 'SKILL.md');
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, '# my own skill, no managed header\n');

    const result = scaffoldAgentSkills(tmpDir, ['claude']);
    expect(result.skipped).toContain(path.join('.claude', 'skills', 'har-wt', 'SKILL.md'));
    expect(fs.readFileSync(skillPath, 'utf8')).toContain('my own skill');

    const forced = scaffoldAgentSkills(tmpDir, ['claude'], { force: true });
    expect(forced.skipped).toHaveLength(0);
    expect(fs.readFileSync(skillPath, 'utf8')).toContain(MANAGED_HEADER);
  });

  it('removes managed files but keeps user-modified ones', () => {
    writeHarnessManifest(tmpDir);
    scaffoldAgentSkills(tmpDir, ['claude']);

    const modified = path.join(tmpDir, '.claude', 'skills', 'setup-har', 'SKILL.md');
    fs.writeFileSync(modified, '# user replaced this\n');

    const removed = removeAgentSkills(tmpDir, ['claude']);
    expect(removed).toHaveLength(2);
    expect(fs.existsSync(modified)).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, '.claude', 'skills', 'har-wt', 'SKILL.md'))).toBe(false);
    expect(readManifest(tmpDir)?.scaffoldedAgentFiles).toHaveLength(0);
  });

  it('detects targets from config dirs and manifest records', () => {
    expect(detectAgentTargets(tmpDir)).toEqual([]);

    fs.mkdirSync(path.join(tmpDir, '.claude'));
    expect(detectAgentTargets(tmpDir)).toEqual(['claude']);

    fs.mkdirSync(path.join(tmpHome, '.codex'));
    expect(detectAgentTargets(tmpDir)).toEqual(['claude', 'codex']);
  });

  it('parses and validates --agents values', () => {
    expect(parseAgentTargets('claude, codex')).toEqual(['claude', 'codex']);
    expect(() => parseAgentTargets('claude,vscode')).toThrow(/Unknown agent target/);
  });
});
