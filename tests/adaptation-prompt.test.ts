import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ADAPTATION_PROMPT_FILE,
  buildInitAdaptationPrompt,
  buildMaintainAdaptationPrompt,
  writeAdaptationPrompt,
} from '../src/harness/adaptation-prompt';
import { initHarness } from '../src/core/harness';

describe('adaptation prompts', () => {
  it('init prompt includes AGENT.md guidance and profile-specific hints', () => {
    const defaultPrompt = buildInitAdaptationPrompt('/tmp/app', 'default');
    expect(defaultPrompt).toContain('AGENT.md');
    expect(defaultPrompt).toContain('Profile: default');
    expect(defaultPrompt).toContain('Docker');

    const cliPrompt = buildInitAdaptationPrompt('/tmp/app', 'cli');
    expect(cliPrompt).toContain('Profile: cli');
    expect(cliPrompt).toContain('worktree');
    expect(cliPrompt).not.toContain('no Docker/PM2');
  });

  it('maintain prompt differs from init and targets drift', () => {
    const initPrompt = buildInitAdaptationPrompt('/tmp/app', 'default');
    const maintainPrompt = buildMaintainAdaptationPrompt('/tmp/app');

    expect(maintainPrompt).not.toEqual(initPrompt);
    expect(maintainPrompt).toContain('already exists');
    expect(maintainPrompt).toContain('targeted edits');
  });

  it('writeAdaptationPrompt creates .har/ADAPT-PROMPT.md', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-adapt-'));
    const harnessDir = path.join(tmpDir, '.har');
    fs.mkdirSync(harnessDir);

    const content = '# Adapt me';
    const filePath = writeAdaptationPrompt(tmpDir, content);

    expect(filePath).toBe(path.join(harnessDir, ADAPTATION_PROMPT_FILE));
    expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
  });
});

describe('initHarness manual default', () => {
  it('scaffolds without ANTHROPIC_API_KEY when auto is false', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-init-'));

    delete process.env.ANTHROPIC_API_KEY;

    const result = await initHarness({
      repoPath: tmpDir,
      profile: 'cli',
      auto: false,
    });

    expect(fs.existsSync(path.join(tmpDir, '.har', 'verify.sh'))).toBe(true);
    expect(result.validation.pass).toBe(true);
    expect(result.adaptationSummary).toBeUndefined();
  });
});
