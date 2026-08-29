import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { compareHarnessToTemplate, computeTemplateChecksums } from '../src/harness/drift';
import { finalizeHarness, scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { readManifest } from '../src/harness/manifest';

describe('two-signal drift (#237)', () => {
  const tmpDirs: string[] = [];

  function scaffoldRepo(prefix: string): string {
    const repoPath = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(repoPath);
    scaffoldHarnessBoilerplate(repoPath, { force: true, profile: 'default' });
    return repoPath;
  }

  afterAll(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('freshly scaffolded harness reports zero drift', () => {
    const repoPath = scaffoldRepo('har-two-signal-fresh-');
    const drift = compareHarnessToTemplate(repoPath);

    expect(drift.userAdapted).toEqual([]);
    expect(drift.upstreamUpdated).toEqual([]);
    expect(drift.conflict).toEqual([]);
    expect(drift.missing).toEqual([]);
    expect(drift.unchanged.length).toBeGreaterThan(0);
  });

  it('adapted-then-finalized harness with no upstream changes reports zero drift', () => {
    const repoPath = scaffoldRepo('har-two-signal-adapted-');
    const readmePath = path.join(repoPath, '.har', 'README.md');
    fs.writeFileSync(readmePath, fs.readFileSync(readmePath, 'utf8') + '\n# repo-specific check\n');

    finalizeHarness(repoPath, 'Adapted README.md for repo-specific notes');
    const drift = compareHarnessToTemplate(repoPath);

    expect(drift.userAdapted).toEqual([]);
    expect(drift.upstreamUpdated).toEqual([]);
    expect(drift.conflict).toEqual([]);
    const entry = drift.files.find((f) => f.file === 'README.md');
    expect(entry?.status).toBe('unchanged');
  });

  it('post-finalize user edit reports user-adapted, not upstream drift', () => {
    const repoPath = scaffoldRepo('har-two-signal-edit-');
    const readmePath = path.join(repoPath, '.har', 'README.md');
    fs.writeFileSync(readmePath, fs.readFileSync(readmePath, 'utf8') + '\n# later edit\n');

    const drift = compareHarnessToTemplate(repoPath);
    const entry = drift.files.find((f) => f.file === 'README.md');
    expect(entry?.status).toBe('user-adapted');
    expect(entry?.userEdited).toBe(true);
    expect(entry?.upstreamUpdated).toBe(false);
  });

  it('upstream template update on a user-adapted file reports conflict', () => {
    const repoPath = scaffoldRepo('har-two-signal-conflict-');
    const manifestPath = path.join(repoPath, '.har', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.templateChecksums['README.md'] = '0000000000000000';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const readmePath = path.join(repoPath, '.har', 'README.md');
    fs.writeFileSync(readmePath, fs.readFileSync(readmePath, 'utf8') + '\n# local edit\n');

    const drift = compareHarnessToTemplate(repoPath);
    expect(drift.conflict).toContain('README.md');
    const entry = drift.files.find((f) => f.file === 'README.md');
    expect(entry?.userEdited).toBe(true);
    expect(entry?.upstreamUpdated).toBe(true);
  });

  it('recurses into .har/stages/ for both signals', () => {
    const repoPath = scaffoldRepo('har-two-signal-stages-');
    const templateChecksums = computeTemplateChecksums(repoPath, 'default');
    const stageFiles = Object.keys(templateChecksums).filter((f) => f.startsWith('stages/'));
    expect(stageFiles.length).toBeGreaterThan(0);

    const manifest = readManifest(repoPath);
    expect(Object.keys(manifest?.fileChecksums ?? {})).toEqual(
      expect.arrayContaining(stageFiles),
    );

    const stageFile = stageFiles[0];
    const stagePath = path.join(repoPath, '.har', stageFile);
    fs.writeFileSync(stagePath, fs.readFileSync(stagePath, 'utf8') + '\n# stage edit\n');

    const drift = compareHarnessToTemplate(repoPath);
    expect(drift.userAdapted).toContain(stageFile);
    // Registered user stages that are not template files are user-owned — never "extra".
    expect(drift.extra.filter((f) => f.startsWith('stages/'))).toEqual([]);
  });

  it('legacy manifest without templateChecksums reports upstream signal as unknown', () => {
    const repoPath = scaffoldRepo('har-two-signal-legacy-');
    const manifestPath = path.join(repoPath, '.har', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest.templateChecksums;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    const readmePath = path.join(repoPath, '.har', 'README.md');
    fs.writeFileSync(readmePath, fs.readFileSync(readmePath, 'utf8') + '\n# local edit\n');

    const drift = compareHarnessToTemplate(repoPath);
    const edited = drift.files.find((f) => f.file === 'README.md');
    expect(edited?.status).toBe('user-adapted');
    expect(edited?.upstreamUpdated).toBeNull();
    const untouched = drift.files.find((f) => f.file === 'harness.env');
    expect(untouched?.status).toBe('unchanged');
    expect(untouched?.upstreamUpdated).toBeNull();
    expect(drift.conflict).toEqual([]);
    expect(drift.upstreamUpdated).toEqual([]);
  });
});
