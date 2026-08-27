import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HARNESS_PROFILES,
  ProfileManifestSchema,
  composeProfileTemplateMap,
  readProfileCapabilities,
  readProfileManifest,
  renderProfileDoc,
} from '../src/harness/profiles';
import {
  harnessAllocatesAppPorts,
  harnessUsesPm2,
  harnessUsesSimulator,
} from '../src/harness/capabilities';
import { detectProcessManager } from '../src/runtime/launch';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { resolveTemplatesDir } from '../src/utils/paths';

const tmpDirs: string[] = [];

function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe('profile capability manifests (#236)', () => {
  it.each([...HARNESS_PROFILES])('%s: manifest parses with a full capability set', (profile) => {
    const manifest = readProfileManifest(profile);
    expect(manifest.capabilities.defaultStages.length).toBeGreaterThan(0);
    expect(manifest.capabilities.defaultEnvKeys.length).toBeGreaterThan(0);
    // #301: README.md is the only generated doc — CLAUDE.agent.md is retired.
    expect(Object.keys(manifest.docs)).toEqual(['README.md']);
  });

  it.each([...HARNESS_PROFILES])(
    '%s: defaultStages matches the profile stages.json (single truth guard)',
    (profile) => {
      const composed = composeProfileTemplateMap(profile);
      const stagesEntry = composed.get('stages.json')!;
      const stages = JSON.parse(fs.readFileSync(stagesEntry.sourcePath, 'utf8'));
      const ids = stages.stages.map((s: { id: string }) => s.id);
      expect(readProfileCapabilities(profile)!.defaultStages).toEqual(ids);
    },
  );

  it.each([...HARNESS_PROFILES])(
    '%s: defaultEnvKeys matches the exported keys of harness.env (single truth guard)',
    (profile) => {
      const composed = composeProfileTemplateMap(profile);
      const envEntry = composed.get('harness.env')!;
      const content = fs.readFileSync(envEntry.sourcePath, 'utf8');
      const keys = [...content.matchAll(/^export ([A-Z_]+)=/gm)].map((m) => m[1]);
      expect(readProfileCapabilities(profile)!.defaultEnvKeys).toEqual(keys);
    },
  );

  it('processManager pm2 implies the pm2-runtime bundle, and only then', () => {
    for (const profile of HARNESS_PROFILES) {
      const manifest = readProfileManifest(profile);
      const hasPm2Bundle = manifest.bundles.some((b) => b.id === 'pm2-runtime');
      expect(hasPm2Bundle).toBe(manifest.capabilities.processManager === 'pm2');
    }
  });
});

describe('capability resolution precedence', () => {
  function scaffold(profile: 'default' | 'cli' | 'ios'): string {
    const repo = tmpDir(`har-cap-${profile}-`);
    scaffoldHarnessBoilerplate(repo, { profile });
    return repo;
  }

  it('manifest capability wins over file presence (default profile)', () => {
    const repo = scaffold('default');
    expect(harnessUsesPm2(repo)).toBe(true);
    expect(detectProcessManager(repo)).toBe('pm2');
    // Deleting the marker file no longer silently changes runtime behavior.
    fs.rmSync(path.join(repo, '.har', 'ecosystem.agent.template.cjs'));
    expect(harnessUsesPm2(repo)).toBe(true);
    expect(detectProcessManager(repo)).toBe('pm2');
    expect(harnessAllocatesAppPorts(repo)).toBe(true);
  });

  it('cli profile resolves to no process manager even with a stray marker file', () => {
    const repo = scaffold('cli');
    fs.writeFileSync(path.join(repo, '.har', 'ecosystem.agent.template.cjs'), 'module.exports={}');
    expect(harnessUsesPm2(repo)).toBe(false);
    expect(detectProcessManager(repo)).toBe('none');
    expect(harnessUsesSimulator(repo)).toBe(false);
  });

  it('ios profile resolves to the simulator process manager from data alone', () => {
    const repo = scaffold('ios');
    expect(harnessUsesSimulator(repo)).toBe(true);
    expect(detectProcessManager(repo)).toBe('simulator');
    expect(harnessUsesPm2(repo)).toBe(false);
  });

  it('legacy harness without a recorded profile falls back to file presence', () => {
    const repo = scaffold('default');
    const manifestPath = path.join(repo, '.har', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest.profile;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    expect(harnessUsesPm2(repo)).toBe(true); // marker file present
    fs.rmSync(path.join(repo, '.har', 'ecosystem.agent.template.cjs'));
    expect(harnessUsesPm2(repo)).toBe(false); // legacy: file presence decides
  });
});

describe('assembled profile docs', () => {
  it.each([...HARNESS_PROFILES])('%s: scaffold writes the assembled README', (profile) => {
    const repo = tmpDir(`har-docs-${profile}-`);
    scaffoldHarnessBoilerplate(repo, { profile });
    const readme = fs.readFileSync(path.join(repo, '.har', 'README.md'), 'utf8');
    expect(readme).toBe(renderProfileDoc(profile, 'README.md'));
    expect(readme).toContain('# .har — Agent Harness');
    expect(readme).toContain('## Session lifecycle');
    // #301: the retired agent doc's unique sections now live in the README.
    expect(readme).toContain('## Definition of done');
    expect(readme).toContain('## Do not');
    expect(fs.existsSync(path.join(repo, '.har', 'CLAUDE.agent.md'))).toBe(false);
  });

  it('shared sections render identically across profiles', () => {
    const defaultReadme = renderProfileDoc('default', 'README.md');
    const cliReadme = renderProfileDoc('cli', 'README.md');
    const iosReadme = renderProfileDoc('ios', 'README.md');
    const shared = fs.readFileSync(
      path.join(resolveTemplatesDir(), 'shared-docs', 'readme', 'session-lifecycle.md'),
      'utf8',
    );
    for (const readme of [defaultReadme, cliReadme, iosReadme]) {
      expect(readme).toContain(shared.trim());
    }
  });

  it('profile overrides beat shared sections (ios README intro)', () => {
    expect(renderProfileDoc('ios', 'README.md')).toContain('iOS');
    expect(renderProfileDoc('ios', 'README.md')).not.toBe(renderProfileDoc('default', 'README.md'));
  });
});

describe('synthetic 4th profile (acceptance)', () => {
  it('a manifest plus profile assets works with zero profile-named branches', () => {
    const templates = tmpDir('har-templates-');
    const profileDir = path.join(templates, 'profiles', 'tui');
    const bundleDir = path.join(templates, 'bundles', 'tui-runtime');
    fs.mkdirSync(path.join(profileDir, 'docs', 'readme'), { recursive: true });
    fs.mkdirSync(path.join(templates, 'shared-docs', 'readme'), { recursive: true });
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'harness.env'), 'export HARNESS_PROJECT_NAME=x\n');
    fs.writeFileSync(
      path.join(templates, 'shared-docs', 'readme', 'shared-part.md'),
      '## Shared part\n\nSame everywhere.\n',
    );
    fs.writeFileSync(path.join(profileDir, 'docs', 'readme', 'intro.md'), '# TUI harness\n');
    const manifest = {
      id: 'tui',
      description: 'Synthetic terminal-UI profile',
      bundles: [{ id: 'tui-runtime', path: 'bundles/tui-runtime' }],
      capabilities: {
        processManager: 'none',
        appPortLanes: false,
        infra: { defaultServices: [], portLanes: '' },
        defaultStages: ['launch'],
        defaultEnvKeys: ['HARNESS_PROJECT_NAME'],
      },
      docs: { 'README.md': ['intro', 'shared-part'] },
    };
    expect(ProfileManifestSchema.safeParse(manifest).success).toBe(true);
    fs.writeFileSync(
      path.join(profileDir, 'profile.manifest.json'),
      JSON.stringify(manifest, null, 2),
    );

    const opts = { templatesDir: templates };
    expect(readProfileCapabilities('tui', opts)!.processManager).toBe('none');
    const composed = composeProfileTemplateMap('tui', opts);
    expect(composed.get('harness.env')!.bundleId).toBe('tui-runtime');
    const readme = composed.get('README.md')!;
    expect(readme.content).toBe('# TUI harness\n\n## Shared part\n\nSame everywhere.\n');
    expect(renderProfileDoc('tui', 'README.md', opts)).toBe(readme.content);
  });
});
