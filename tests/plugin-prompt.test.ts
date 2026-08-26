import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { applyPlugin } from '../src/harness/plugins';
import {
  buildPluginAdaptationPrompt,
  pluginAdaptationPromptFile,
  resolveInstallCommand,
} from '../src/harness/plugin-prompt';

function makeTempRepo(name: string): string {
  const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  fs.writeFileSync(
    path.join(repoPath, 'package.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
  );
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'cli' });
  return repoPath;
}

describe('post-add-plugin adaptation prompt (#195)', () => {
  it('add-plugin writes .har/ADAPT-PROMPT-<id>.md and reports its path', () => {
    const repoPath = makeTempRepo('har-plugin-prompt');
    const result = applyPlugin(repoPath, 'playwright', { skipCi: true });

    expect(result.adaptPromptPath).toBe(path.join('.har', 'ADAPT-PROMPT-playwright.md'));
    const promptPath = path.join(repoPath, result.adaptPromptPath);
    expect(fs.existsSync(promptPath)).toBe(true);

    const content = fs.readFileSync(promptPath, 'utf8');
    // Tokens substituted, none leaked.
    expect(content).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(content).toContain('`playwright`');
    expect(content).toContain('`browser-e2e`');
    expect(content).toContain('.har/stages/PLAYWRIGHT.md');
    // Manifest nextSteps folded in (minus the bare install line, covered below).
    expect(content).toContain('npx playwright install');
    // merged ≠ installed is explicit, with the repo's real install command.
    expect(content).toContain('merged is NOT installed');
    expect(content).toContain(resolveInstallCommand(repoPath));
  });

  it('drops the manifest\'s bare "<pm> install" step when the merge note already leads with it', () => {
    const repoPath = makeTempRepo('har-plugin-prompt-dedup');
    const result = applyPlugin(repoPath, 'playwright', { skipCi: true });
    const content = fs.readFileSync(path.join(repoPath, result.adaptPromptPath), 'utf8');
    const setupSection = content.split('## Plugin setup steps')[1].split('## Adapt')[0];
    expect(setupSection).not.toMatch(/^\d+\. `npm install`$/m);
  });

  it('honors HARNESS_INSTALL_CMD over the detected package manager', () => {
    const repoPath = makeTempRepo('har-plugin-prompt-install-cmd');
    fs.appendFileSync(
      path.join(repoPath, '.har', 'harness.env'),
      '\nexport HARNESS_INSTALL_CMD="pnpm install --frozen-lockfile"\n',
    );
    expect(resolveInstallCommand(repoPath)).toBe('pnpm install --frozen-lockfile');
    const result = applyPlugin(repoPath, 'playwright', { skipCi: true, force: true });
    const content = fs.readFileSync(path.join(repoPath, result.adaptPromptPath), 'utf8');
    expect(content).toContain('pnpm install --frozen-lockfile');
  });

  it('skips the dependency-install framing for plugins without a package fragment', () => {
    const repoPath = makeTempRepo('har-plugin-prompt-nomerge');
    const result = applyPlugin(repoPath, 'gitleaks', { skipCi: true });
    const content = fs.readFileSync(path.join(repoPath, result.adaptPromptPath), 'utf8');
    expect(content).toContain('no dependency install is required');
    expect(content).not.toContain('merged is NOT installed');
  });

  it('does not write a prompt when the plugin install fails', () => {
    const repoPath = makeTempRepo('har-plugin-prompt-fail');
    // Pre-existing stage script → applyPlugin throws before completion.
    const stagePath = path.join(repoPath, '.har', 'stages', 'browser-e2e.sh');
    fs.mkdirSync(path.dirname(stagePath), { recursive: true });
    fs.writeFileSync(stagePath, '#!/usr/bin/env bash\n');

    expect(() => applyPlugin(repoPath, 'playwright', { skipCi: true })).toThrow(/already exists/);
    expect(
      fs.existsSync(path.join(repoPath, '.har', pluginAdaptationPromptFile('playwright'))),
    ).toBe(false);
  });

  it('buildPluginAdaptationPrompt lists scaffolded files but not package.json', () => {
    const repoPath = makeTempRepo('har-plugin-prompt-files');
    const result = applyPlugin(repoPath, 'playwright', { skipCi: true });
    const content = buildPluginAdaptationPrompt(repoPath, result);
    expect(content).toContain('`playwright.config.js`');
    expect(content).not.toMatch(/^ {3}- `package\.json`$/m);
  });
});
