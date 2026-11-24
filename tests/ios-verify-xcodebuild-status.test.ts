import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { resolveTemplatesDir } from '../src/utils/paths';

const IOS_TEMPLATE = path.join(resolveTemplatesDir(), 'har-boilerplate-ios');

function stageCommand(name: string): string {
  const registry = JSON.parse(
    fs.readFileSync(path.join(IOS_TEMPLATE, 'stages.json'), 'utf8'),
  ) as { stages: Array<{ id: string; command?: string }> };
  return registry.stages.find((s) => s.id === name)?.command ?? '';
}

/**
 * Run a stage command the way verify-runner.mjs does (`bash -c`, no pipefail
 * inherited) against a fake xcodebuild that logs each call and exits with
 * `xcodebuildExit`, and optionally a fake xcbeautify that always exits 0.
 */
function runStage(
  name: string,
  opts: { xcodebuildExit: number; withXcbeautify: boolean },
): { status: number | null; output: string; calls: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-xc-status-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  const xcodebuild = path.join(dir, 'xcodebuild');
  fs.writeFileSync(
    xcodebuild,
    `#!/usr/bin/env bash\necho "$*" >> "${log}"\necho "** TEST FAILED **"\nexit ${opts.xcodebuildExit}\n`,
    { mode: 0o755 },
  );
  if (opts.withXcbeautify) {
    fs.writeFileSync(
      path.join(bin, 'xcbeautify'),
      '#!/usr/bin/env bash\necho "xcbeautify $*"\ncat\nexit 0\n',
      { mode: 0o755 },
    );
  }
  const res = spawnSync('bash', ['-c', stageCommand(name)], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: `${bin}:/usr/bin:/bin`,
      XCODEBUILD_BIN: xcodebuild,
      XC_FLAGS: '',
      XC_SCHEME: 'MyApp',
      XC_DESTINATION: 'platform=iOS Simulator,id=X',
      XC_DERIVED: path.join(dir, 'derived'),
    },
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [];
  return { status: res.status, output: `${res.stdout}${res.stderr}`, calls };
}

describe('iOS xcodebuild stages report xcodebuild status (#368)', () => {
  for (const name of ['build', 'unit-tests']) {
    describe(name, () => {
      it('fails when xcodebuild fails, even though xcbeautify exits 0', () => {
        const res = runStage(name, { xcodebuildExit: 65, withXcbeautify: true });
        expect(res.status).not.toBe(0);
      });

      it('runs xcodebuild once on failure — never retries unformatted', () => {
        const res = runStage(name, { xcodebuildExit: 65, withXcbeautify: true });
        expect(res.calls).toHaveLength(1);
      });

      it('keeps unparsed lines like ** TEST FAILED ** through xcbeautify', () => {
        const res = runStage(name, { xcodebuildExit: 65, withXcbeautify: true });
        expect(res.output).toContain('xcbeautify --preserve-unbeautified');
        expect(res.output).toContain('** TEST FAILED **');
      });

      it('fails and shows raw output when xcbeautify is not installed', () => {
        const res = runStage(name, { xcodebuildExit: 65, withXcbeautify: false });
        expect(res.status).not.toBe(0);
        expect(res.calls).toHaveLength(1);
        expect(res.output).toContain('** TEST FAILED **');
      });

      it('passes when xcodebuild passes', () => {
        expect(runStage(name, { xcodebuildExit: 0, withXcbeautify: true }).status).toBe(0);
        expect(runStage(name, { xcodebuildExit: 0, withXcbeautify: false }).status).toBe(0);
      });
    });
  }

  it('skips simulator diagnostics collection on test failure (600 s simctl diagnose stall)', () => {
    const res = runStage('unit-tests', { xcodebuildExit: 65, withXcbeautify: true });
    expect(res.calls[0]).toContain('-collect-test-diagnostics never');
    expect(stageCommand('build')).not.toContain('-collect-test-diagnostics');
  });
});
