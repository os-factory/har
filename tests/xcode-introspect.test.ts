import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectXcodeProject,
  GENERATOR_MANIFESTS,
  introspectXcodeProject,
  suggestsIosProfile,
  xcodeHarnessEnvValues,
} from '../src/harness/xcode-introspect';
import { resolveTemplatesDir } from '../src/utils/paths';
import { stubXcodebuild, withPath } from './helpers/stub-bin';

function makeProjectDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // Xcode always nests a project.xcworkspace inside the project bundle.
  fs.mkdirSync(path.join(dir, 'MyApp.xcodeproj', 'project.xcworkspace'), { recursive: true });
  return dir;
}

describe('detectXcodeProject', () => {
  it('finds the project and ignores the workspace nested inside it', () => {
    const dir = makeProjectDir('har-xci-detect-');

    const location = detectXcodeProject(dir);

    expect(location).not.toBeNull();
    expect(location?.project).toBe('MyApp.xcodeproj');
    expect(location?.workspace).toBeUndefined();
  });

  it('prefers a real workspace sitting beside the project', () => {
    const dir = makeProjectDir('har-xci-ws-');
    fs.mkdirSync(path.join(dir, 'MyApp.xcworkspace'));

    expect(detectXcodeProject(dir)?.workspace).toBe('MyApp.xcworkspace');
  });

  it('skips Pods, which ships its own project', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-xci-pods-'));
    fs.mkdirSync(path.join(dir, 'Pods', 'Pods.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'MyApp.xcodeproj'), { recursive: true });

    expect(detectXcodeProject(dir)?.project).toBe('MyApp.xcodeproj');
  });

  it('reports the generator when the project is a build product', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-xci-tuist-'));
    fs.writeFileSync(path.join(dir, 'Project.swift'), 'let project = Project()\n');

    const location = detectXcodeProject(dir);

    expect(location?.generator).toBe('tuist');
    expect(location?.project).toBeUndefined();
  });

  it('returns null on a repository with nothing Xcode about it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-xci-none-'));
    fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n');

    expect(detectXcodeProject(dir)).toBeNull();
  });

  it('reports every candidate, sorted, when more than one project exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-xci-many-'));
    fs.mkdirSync(path.join(dir, 'Zeta.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'Alpha.xcodeproj'), { recursive: true });

    const location = detectXcodeProject(dir);

    // Sorted, not readdir order, so the arbitrary pick is at least reproducible.
    expect(location?.candidates).toEqual(['Alpha.xcodeproj', 'Zeta.xcodeproj']);
    expect(location?.project).toBe('Alpha.xcodeproj');
  });
});

describe('generator manifest contract', () => {
  it('matches the order provision-toolchain.sh checks', () => {
    const script = fs.readFileSync(
      path.join(resolveTemplatesDir(), 'har-boilerplate-ios', 'provision-toolchain.sh'),
      'utf8',
    );
    // The bash side re-implements this precedence; binding them here means a
    // divergence fails a test rather than silently disagreeing at launch.
    const positions = GENERATOR_MANIFESTS.map((entry) => {
      const at = script.indexOf(`$dir/${entry.manifest}`);
      expect(at).toBeGreaterThan(-1);
      return at;
    });
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe('introspectXcodeProject', () => {
  it('resolves scheme and bundle id from a single-scheme project', () => {
    const dir = makeProjectDir('har-xci-single-');
    const binDir = stubXcodebuild(dir);

    const info = withPath(`${binDir}:/usr/bin:/bin`, () => introspectXcodeProject(dir));

    expect(info.confidence).toBe('high');
    expect(info.scheme).toBe('MyApp');
    expect(info.bundleId).toBe('com.acme.myapp');
    expect(info.warnings).toEqual([]);
    expect(xcodeHarnessEnvValues(info)).toEqual({
      HARNESS_XCODE_PROJECT: 'MyApp.xcodeproj',
      HARNESS_XCODE_SCHEME: 'MyApp',
      HARNESS_BUNDLE_ID: 'com.acme.myapp',
    });
  });

  it('leaves the scheme unset and lists candidates when the choice is ambiguous', () => {
    const dir = makeProjectDir('har-xci-ambiguous-');
    const binDir = stubXcodebuild(dir, {
      list: { project: { name: 'MyApp', schemes: ['Alpha', 'Beta', 'Gamma'] } },
    });

    const info = withPath(`${binDir}:/usr/bin:/bin`, () => introspectXcodeProject(dir));

    // Guessing wrong costs more than leaving it blank.
    expect(info.scheme).toBeUndefined();
    expect(info.confidence).toBe('partial');
    expect(info.warnings.join(' ')).toContain('Alpha, Beta, Gamma');
    expect(xcodeHarnessEnvValues(info)).not.toHaveProperty('HARNESS_XCODE_SCHEME');
  });

  it('resolves the ambiguity when one scheme carries the project name', () => {
    const dir = makeProjectDir('har-xci-named-');
    const binDir = stubXcodebuild(dir, {
      list: { project: { name: 'MyApp', schemes: ['MyAppTests', 'MyApp', 'MyAppUITests'] } },
    });

    const info = withPath(`${binDir}:/usr/bin:/bin`, () => introspectXcodeProject(dir));

    expect(info.scheme).toBe('MyApp');
    expect(info.confidence).toBe('high');
  });

  it('degrades to a partial result when xcodebuild is unavailable', () => {
    const dir = makeProjectDir('har-xci-noxcode-');

    // An empty PATH stands in for a machine without Xcode — Linux CI, for instance.
    const info = withPath('/nonexistent', () => introspectXcodeProject(dir));

    expect(info.confidence).toBe('partial');
    expect(info.project).toBe('MyApp.xcodeproj');
    expect(info.warnings.join(' ')).toContain('xcodebuild is not available');
  });

  it('explains itself when the project has yet to be generated', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-xci-gen-'));
    fs.writeFileSync(path.join(dir, 'Project.swift'), 'let project = Project()\n');
    const binDir = stubXcodebuild(dir);

    const info = withPath(`${binDir}:/usr/bin:/bin`, () => introspectXcodeProject(dir));

    expect(info.confidence).toBe('partial');
    expect(info.warnings.join(' ')).toContain('tuist');
  });

  it('tells a timeout apart from a failure', () => {
    const dir = makeProjectDir('har-xci-timeout-');
    const binDir = stubXcodebuild(dir, { sleepSeconds: 5 });

    const info = withPath(`${binDir}:/usr/bin:/bin`, () =>
      introspectXcodeProject(dir, { listTimeoutMs: 300 }),
    );

    expect(info.warnings.join(' ')).toContain('timed out');
  });

  it('keeps going when xcodebuild -list fails outright', () => {
    const dir = makeProjectDir('har-xci-listfail-');
    const binDir = stubXcodebuild(dir, { listExit: 65 });

    const info = withPath(`${binDir}:/usr/bin:/bin`, () => introspectXcodeProject(dir));

    expect(info.confidence).toBe('partial');
    expect(info.warnings.join(' ')).toContain('xcodebuild -list failed');
  });

  it('warns when nothing Xcode-shaped is here at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-xci-empty-'));
    fs.writeFileSync(path.join(dir, 'main.go'), 'package main\n');

    const info = withPath('/nonexistent', () => introspectXcodeProject(dir));

    // The case that most needs a message must not be the silent one.
    expect(info.confidence).toBe('none');
    expect(info.warnings.length).toBeGreaterThan(0);
    expect(info.warnings.join(' ')).toContain('--profile');
  });

  it('names the alternatives when several projects could have been picked', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-xci-multi-'));
    fs.mkdirSync(path.join(dir, 'Alpha.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'Beta.xcodeproj'), { recursive: true });
    const binDir = stubXcodebuild(dir);

    const info = withPath(`${binDir}:/usr/bin:/bin`, () => introspectXcodeProject(dir));

    expect(info.warnings.join(' ')).toContain('Beta.xcodeproj');
  });

  it('blames the parser, not the project, for unreadable build settings', () => {
    const dir = makeProjectDir('har-xci-badjson-');
    const binDir = stubXcodebuild(dir, { settings: 'not json at all' });

    const info = withPath(`${binDir}:/usr/bin:/bin`, () => introspectXcodeProject(dir));

    expect(info.warnings.join(' ')).toContain('Could not parse');
    expect(info.warnings.join(' ')).not.toContain('PRODUCT_BUNDLE_IDENTIFIER is not set');
  });

  it('reports an unshared scheme as the actionable problem it is', () => {
    const dir = makeProjectDir('har-xci-noscheme-');
    const binDir = stubXcodebuild(dir, { list: { project: { name: 'MyApp', schemes: [] } } });

    const info = withPath(`${binDir}:/usr/bin:/bin`, () => introspectXcodeProject(dir));

    expect(info.warnings.join(' ')).toContain('shared');
  });
});

describe('suggestsIosProfile', () => {
  it('suggests iOS for a project at the repository root', () => {
    const dir = makeProjectDir('har-xci-suggest-');

    expect(suggestsIosProfile(dir)).toBe(true);
  });

  it('stays quiet when another ecosystem owns the root', () => {
    const dir = makeProjectDir('har-xci-rn-');
    // React Native and friends: JS at the root, Xcode below it.
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"app"}');

    expect(suggestsIosProfile(dir)).toBe(false);
  });

  it('stays quiet when the project sits in a subdirectory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-xci-sub-'));
    fs.mkdirSync(path.join(dir, 'ios', 'MyApp.xcodeproj'), { recursive: true });

    expect(suggestsIosProfile(dir)).toBe(false);
  });

  it('suggests iOS for a Tuist repository with no generated project yet', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-xci-suggest-tuist-'));
    fs.writeFileSync(path.join(dir, 'Project.swift'), 'let project = Project()\n');

    expect(suggestsIosProfile(dir)).toBe(true);
  });
});
