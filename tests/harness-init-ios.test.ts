import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { initHarness } from '../src/core/harness';
import { compareHarnessToTemplate } from '../src/harness/drift';
import { readHarnessEnv } from '../src/harness/env';
import { computeFileChecksum, readManifest } from '../src/harness/manifest';
import { stubXcodebuild } from './helpers/stub-bin';

function makeIosRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-init-ios-'));
  fs.mkdirSync(path.join(dir, 'MyApp.xcodeproj', 'project.xcworkspace'), { recursive: true });
  return dir;
}

async function initIos(
  dir: string,
  options: { introspect?: boolean } = {},
): Promise<Awaited<ReturnType<typeof initHarness>>> {
  const original = process.env.PATH;
  process.env.PATH = `${stubXcodebuild(dir)}:${original ?? '/usr/bin:/bin'}`;
  try {
    return await initHarness({ repoPath: dir, profile: 'ios', ...options });
  } finally {
    process.env.PATH = original;
  }
}

describe('har env init --profile ios', () => {
  it('writes the introspected project into harness.env', async () => {
    const dir = makeIosRepo();

    await initIos(dir);

    const env = readHarnessEnv(dir);
    expect(env.HARNESS_XCODE_SCHEME).toBe('MyApp');
    expect(env.HARNESS_BUNDLE_ID).toBe('com.acme.myapp');
    expect(env.HARNESS_XCODE_PROJECT).toBe('MyApp.xcodeproj');
  });

  it('records what it generated in the manifest', async () => {
    const dir = makeIosRepo();

    await initIos(dir);

    expect(readManifest(dir)?.initEnvOverrides).toEqual({
      HARNESS_XCODE_PROJECT: 'MyApp.xcodeproj',
      HARNESS_XCODE_SCHEME: 'MyApp',
      HARNESS_BUNDLE_ID: 'com.acme.myapp',
    });
  });

  // The regression this whole feature hinges on. Without the drift replay, `maintain`
  // hands a coding agent a diff that restores the MyApp / com.example.myapp
  // placeholders — the generated config would silently undo itself.
  it('does not report its own generated harness.env as drift', async () => {
    const dir = makeIosRepo();

    await initIos(dir);
    const drift = compareHarnessToTemplate(dir);

    expect(drift.checksumMismatch).not.toContain('harness.env');
    expect(drift.unchanged).toContain('harness.env');
  });

  it('still reports a genuine local edit as drift', async () => {
    const dir = makeIosRepo();
    await initIos(dir);

    const envPath = path.join(dir, '.har', 'harness.env');
    fs.writeFileSync(
      envPath,
      fs.readFileSync(envPath, 'utf8').replace('HARNESS_SIMULATOR_FAMILY="auto"', 'HARNESS_SIMULATOR_FAMILY="iPad"'),
    );

    expect(compareHarnessToTemplate(dir).checksumMismatch).toContain('harness.env');
  });

  it('surfaces unresolved config as warnings rather than failing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-init-ios-gen-'));
    fs.writeFileSync(path.join(dir, 'Project.swift'), 'let project = Project()\n');

    const result = await initIos(dir);

    expect(result.validation.pass).toBe(true);
    expect(result.warnings.join(' ')).toContain('tuist');
    expect(result.introspection?.confidence).toBe('partial');
  });

  it('flags the placeholders left behind when introspection is skipped', async () => {
    const dir = makeIosRepo();

    const result = await initIos(dir, { introspect: false });

    expect(readManifest(dir)?.initEnvOverrides).toBeUndefined();
    expect(compareHarnessToTemplate(dir).checksumMismatch).not.toContain('harness.env');
    const messages = result.validation.issues.map((issue) => issue.message).join(' ');
    expect(messages).toContain('HARNESS_XCODE_SCHEME');
  });

  it('seals manifest checksums against the harness.env actually on disk', async () => {
    // syncAgentSlotsToHarnessEnv runs again after createManifest has sealed the
    // checksums. It is a no-op today only because template and stages.json agree —
    // this locks that in, so a future template divergence fails here rather than
    // surfacing as phantom drift.
    const dir = makeIosRepo();

    await initIos(dir);

    const manifest = readManifest(dir);
    const onDisk = fs.readFileSync(path.join(dir, '.har', 'harness.env'), 'utf8');
    expect(manifest?.fileChecksums?.['harness.env']).toBe(computeFileChecksum(onDisk));
  });

  it('leaves the other profiles untouched', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-init-cli-'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture"}');

    const result = await initHarness({ repoPath: dir, profile: 'cli' });

    expect(readManifest(dir)?.initEnvOverrides).toBeUndefined();
    expect(result.warnings).toEqual([]);
    expect(result.introspection).toBeUndefined();
    expect(compareHarnessToTemplate(dir).checksumMismatch).not.toContain('harness.env');
  });
});
