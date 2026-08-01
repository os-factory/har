import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { buildMaintainBundle } from '../src/harness/maintain-bundle';
import { applyPlugin } from '../src/harness/plugins';
import {
  compareInstalledPluginsToTemplate,
  comparePluginToTemplate,
  detectInstalledPlugins,
} from '../src/harness/plugin-drift';
import { validateHarness } from '../src/harness/validator';
import { compareHarnessToTemplate } from '../src/harness/drift';

function makeTempRepo(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function scaffoldRepoWithPlugin(name: string): string {
  const repoPath = makeTempRepo(name);
  fs.writeFileSync(
    path.join(repoPath, 'package.json'),
    JSON.stringify({ name: 'test-app', version: '1.0.0' }, null, 2) + '\n',
  );
  scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'default' });
  applyPlugin(repoPath, 'playwright', { skipCi: true });
  return repoPath;
}

describe('plugin drift', () => {
  it('detects playwright after add-plugin', () => {
    const repoPath = scaffoldRepoWithPlugin('har-plugin-detect');

    expect(detectInstalledPlugins(repoPath)).toEqual(['playwright']);
  });

  it('reports no drift when plugin files match bundled templates', () => {
    const repoPath = scaffoldRepoWithPlugin('har-plugin-fresh');

    const drift = comparePluginToTemplate(repoPath, 'playwright');
    expect(drift.missing).toEqual([]);
    expect(drift.checksumMismatch).toEqual([]);
    expect(drift.unchanged.length).toBeGreaterThan(0);
  });

  it('reports drift when a plugin file was customized', () => {
    const repoPath = scaffoldRepoWithPlugin('har-plugin-drift');

    const configPath = path.join(repoPath, 'playwright.config.js');
    fs.writeFileSync(configPath, `${fs.readFileSync(configPath, 'utf8')}\n// customized\n`);

    const drift = comparePluginToTemplate(repoPath, 'playwright');
    expect(drift.checksumMismatch).toContain('playwright.config.js');
  });

  it('includes plugin drift in maintain bundle artifacts', () => {
    const repoPath = scaffoldRepoWithPlugin('har-plugin-bundle');

    const configPath = path.join(repoPath, 'playwright.config.js');
    fs.writeFileSync(configPath, `${fs.readFileSync(configPath, 'utf8')}\n// customized\n`);

    const drift = compareHarnessToTemplate(repoPath);
    const validation = validateHarness(repoPath);
    const { bundleDir, report } = buildMaintainBundle(repoPath, validation, drift);

    expect(report.pluginDrift.some((entry) => entry.pluginId === 'playwright')).toBe(true);
    expect(report.pluginActions.some((action) => action.file === 'playwright.config.js')).toBe(true);
    expect(
      fs.existsSync(path.join(bundleDir, 'plugins', 'playwright', 'diffs', 'playwright.config.js.diff')),
    ).toBe(true);
    expect(fs.readFileSync(path.join(bundleDir, 'README.md'), 'utf8')).toContain('Plugin drift');
  });

  it('compareInstalledPluginsToTemplate skips plugins that are not installed', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-plugin-none-'));
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'default' });

    expect(compareInstalledPluginsToTemplate(repoPath)).toEqual([]);
  });
});
