import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { run } from '../src/utils/shell';
import { resolveTemplatesDir } from '../src/utils/paths';

const VERIFY = path.join(resolveTemplatesDir(), 'har-boilerplate-ios', 'verify.sh');

/**
 * Run verify.sh's xc_target_flags against a fixture work dir. The function is
 * lifted out of the script so the test exercises the real detection logic
 * without booting a simulator.
 */
function xcTargetFlags(workDir: string, env: Record<string, string> = {}): string {
  const script = fs.readFileSync(VERIFY, 'utf8');
  const start = script.indexOf('xc_target_flags() {');
  expect(start).toBeGreaterThanOrEqual(0);
  const end = script.indexOf('\n}\n', start);
  expect(end).toBeGreaterThan(start);
  const fn = script.slice(start, end + 3);

  const runner = path.join(workDir, 'run-xc-target-flags.sh');
  fs.writeFileSync(
    runner,
    ['set -euo pipefail', `WORK_DIR="${workDir}"`, fn, 'xc_target_flags', ''].join('\n'),
  );

  const assignments = Object.entries(env)
    .map(([key, value]) => `${key}="${value}" `)
    .join('');
  const result = run(`${assignments}bash "${runner}"`);
  expect(result.code).toBe(0);
  return result.stdout.trim();
}

/** Work dir whose path contains a dot component, like a real session worktree. */
function fixture(name: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `har-xc-${name}-`));
  const dir = path.join(root, '.har', 'work');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe('iOS verify.sh xc_target_flags auto-detection', () => {
  it('picks the real project, not the .xcworkspace nested inside it', () => {
    const dir = fixture('nested');
    fs.mkdirSync(path.join(dir, 'MyApp.xcodeproj', 'project.xcworkspace'), { recursive: true });

    expect(xcTargetFlags(dir)).toBe(`-project ${dir}/MyApp.xcodeproj`);
  });

  it('prefers a real workspace over the project', () => {
    const dir = fixture('workspace');
    fs.mkdirSync(path.join(dir, 'MyApp.xcworkspace'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'MyApp.xcodeproj', 'project.xcworkspace'), { recursive: true });

    expect(xcTargetFlags(dir)).toBe(`-workspace ${dir}/MyApp.xcworkspace`);
  });

  it('never selects the CocoaPods project under Pods/', () => {
    const dir = fixture('pods');
    fs.mkdirSync(path.join(dir, 'Pods', 'Pods.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'MyApp.xcodeproj'), { recursive: true });

    expect(xcTargetFlags(dir)).toBe(`-project ${dir}/MyApp.xcodeproj`);
  });

  it('honors the adapt-time workspace and project values', () => {
    const dir = fixture('explicit');
    fs.mkdirSync(path.join(dir, 'App', 'Other.xcodeproj'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'App', 'Real.xcworkspace'), { recursive: true });

    expect(xcTargetFlags(dir, { HARNESS_XCODE_WORKSPACE: 'App/Real.xcworkspace' })).toBe(
      `-workspace ${dir}/App/Real.xcworkspace`,
    );
    expect(xcTargetFlags(dir, { HARNESS_XCODE_PROJECT: 'App/Other.xcodeproj' })).toBe(
      `-project ${dir}/App/Other.xcodeproj`,
    );
  });

  it('emits nothing when the worktree has no project yet', () => {
    expect(xcTargetFlags(fixture('empty'))).toBe('');
  });
});
