import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compareHarnessToTemplate } from '../src/harness/drift';
import { RUNTIME_SHIM_FILES, substituteTemplateTokens } from '../src/harness/template-tokens';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import {
  composeProfileTemplateMap,
  readComposedTemplateContent,
  readProfileManifest,
  resolveProfileBundleDir,
  HARNESS_PROFILES,
} from '../src/harness/profiles';

const tmpDirs: string[] = [];

afterAll(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function walk(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

describe('profile bundle composition', () => {
  for (const profile of HARNESS_PROFILES) {
    it(`${profile}: no file is served by more than one bundle`, () => {
      const servedBy = new Map<string, string[]>();
      for (const bundle of readProfileManifest(profile).bundles) {
        for (const rel of walk(resolveProfileBundleDir(bundle))) {
          servedBy.set(rel, [...(servedBy.get(rel) ?? []), bundle.id]);
        }
      }
      const duplicated = [...servedBy.entries()].filter(([, ids]) => ids.length > 1);
      expect(duplicated).toEqual([]);
    });

    it(`${profile}: scaffolded .har/ is byte-identical to the composed bundle set`, () => {
      const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), `har-compose-${profile}-`));
      tmpDirs.push(repoPath);
      scaffoldHarnessBoilerplate(repoPath, { profile });

      const harnessDir = path.join(repoPath, '.har');
      const composed = composeProfileTemplateMap(profile);
      const projectName = path
        .basename(repoPath)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_');

      for (const entry of composed.values()) {
        const installedPath = path.join(harnessDir, entry.relPath);
        expect(fs.existsSync(installedPath)).toBe(true);
        let expected = readComposedTemplateContent(entry);
        if (
          entry.relPath === 'harness.env' ||
          (RUNTIME_SHIM_FILES as readonly string[]).includes(entry.relPath)
        ) {
          expected = substituteTemplateTokens(expected, projectName);
        }
        expect(fs.readFileSync(installedPath, 'utf8')).toBe(expected);
      }

      // Everything else in .har/ must be a known generated file, so the composed
      // map stays the single source of truth for template content.
      const generated = new Set(['.gitignore', 'manifest.json', 'plugins.json']);
      const extras = walk(harnessDir).filter((rel) => !composed.has(rel) && !generated.has(rel));
      expect(extras).toEqual([]);
    });
  }
});

describe('adaptation prompt is generated, not templated', () => {
  it('no bundle ships a static ADAPT-PROMPT.md', () => {
    for (const profile of HARNESS_PROFILES) {
      expect(composeProfileTemplateMap(profile).has('ADAPT-PROMPT.md')).toBe(false);
    }
  });

  it('ios: onboarding-written ADAPT-PROMPT.md causes no day-one drift', () => {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), 'har-ios-drift-'));
    tmpDirs.push(repoPath);
    scaffoldHarnessBoilerplate(repoPath, { profile: 'ios' });
    // Onboarding rewrites the prompt with project-specific content.
    fs.writeFileSync(
      path.join(repoPath, '.har', 'ADAPT-PROMPT.md'),
      '# Adapt this harness\nproject-specific content\n',
    );

    const drift = compareHarnessToTemplate(repoPath);
    const flagged = [...drift.missing, ...drift.checksumMismatch, ...drift.extra];
    expect(flagged.filter((f) => f.startsWith('ADAPT-PROMPT'))).toEqual([]);
  });
});
