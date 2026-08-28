import * as fs from 'fs';
import * as path from 'path';
import { renderProfileDoc } from '../src/harness/profiles';
import { resolveTemplatesDir } from '../src/utils/paths';

const IOS_TEMPLATE = path.join(resolveTemplatesDir(), 'har-boilerplate-ios');

/** Command of a verification stage registered in the iOS template stages.json. */
function stageCommand(name: string): string {
  const registry = JSON.parse(
    fs.readFileSync(path.join(IOS_TEMPLATE, 'stages.json'), 'utf8'),
  ) as { stages: Array<{ id: string; command?: string }> };
  const stage = registry.stages.find((s) => s.id === name);
  expect(stage?.command).toBeTruthy();
  return stage?.command ?? '';
}

describe('iOS verification stage code signing', () => {
  it('disables code signing for the compile-only build stage', () => {
    expect(stageCommand('build')).toContain('CODE_SIGNING_ALLOWED=NO');
  });

  // Tests install and run the host app on the simulator. Unsigned means no
  // entitlements, so an app using iCloud, KVS, or push traps on launch before the
  // test harness connects — every test in the bundle is lost.
  it('leaves code signing alone for the unit-tests stage', () => {
    const unitTests = stageCommand('unit-tests');
    expect(unitTests).toContain('xcodebuild} test');
    expect(unitTests).not.toContain('CODE_SIGNING');
  });

  it('keeps the harness doc xcodebuild examples in step with the stage commands', () => {
    // #301: the agent doc is retired; its project-commands section composes into README.md.
    const doc = renderProfileDoc('ios', 'README.md');
    const examples = doc.split('\n').filter((line) => line.startsWith('xcodebuild '));
    const build = examples.filter((line) => line.includes('xcodebuild build'));
    const test = examples.filter((line) => line.includes('xcodebuild test'));

    expect(build.length).toBeGreaterThan(0);
    expect(test.length).toBeGreaterThan(0);
    expect(build.every((line) => line.includes('CODE_SIGNING_ALLOWED=NO'))).toBe(true);
    expect(test.some((line) => line.includes('CODE_SIGNING'))).toBe(false);
  });
});
