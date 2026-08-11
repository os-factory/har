import * as fs from 'fs';
import * as path from 'path';
import { resolveTemplatesDir } from '../src/utils/paths';

const IOS_TEMPLATE = path.join(resolveTemplatesDir(), 'har-boilerplate-ios');

/**
 * Body of a `run_step "<name>" '<command>'` block. Step commands are
 * single-quoted in verify.sh and contain no single quote of their own.
 */
function runStepCommand(script: string, name: string): string {
  const marker = `run_step "${name}" '`;
  const start = script.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const from = start + marker.length;
  const end = script.indexOf("'", from);
  expect(end).toBeGreaterThan(from);
  return script.slice(from, end);
}

describe('iOS verify.sh code signing', () => {
  const verify = fs.readFileSync(path.join(IOS_TEMPLATE, 'verify.sh'), 'utf8');

  it('disables code signing for the compile-only build step', () => {
    expect(runStepCommand(verify, 'build')).toContain('CODE_SIGNING_ALLOWED=NO');
  });

  // Tests install and run the host app on the simulator. Unsigned means no
  // entitlements, so an app using iCloud, KVS, or push traps on launch before the
  // test harness connects — every test in the bundle is lost.
  it('leaves code signing alone for the unit-tests step', () => {
    const unitTests = runStepCommand(verify, 'unit-tests');
    expect(unitTests).toContain('xcodebuild} test');
    expect(unitTests).not.toContain('CODE_SIGNING');
  });

  it('keeps the agent doc xcodebuild examples in step with verify.sh', () => {
    const doc = fs.readFileSync(path.join(IOS_TEMPLATE, 'CLAUDE.agent.md'), 'utf8');
    const examples = doc.split('\n').filter((line) => line.startsWith('xcodebuild '));
    const build = examples.filter((line) => line.includes('xcodebuild build'));
    const test = examples.filter((line) => line.includes('xcodebuild test'));

    expect(build.length).toBeGreaterThan(0);
    expect(test.length).toBeGreaterThan(0);
    expect(build.every((line) => line.includes('CODE_SIGNING_ALLOWED=NO'))).toBe(true);
    expect(test.some((line) => line.includes('CODE_SIGNING'))).toBe(false);
  });
});
