import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { maintainHarness } from '../src/core/harness';
import { runDoctor } from '../src/harness/doctor';
import { adoptHarness, ejectHarness } from '../src/harness/eject';
import { scaffoldHarnessBoilerplate } from '../src/harness/generator';
import { computeFileChecksum, readManifest, writeManifest } from '../src/harness/manifest';
import {
  findStaleRunnerCopy,
  packagedVerifyRunner,
  removeStaleRunnerCopy,
} from '../src/harness/stage-runner';
import { resolveVerifyRunner } from '../src/runtime/verify';

/**
 * HAR 2.0 runs its packaged stage runner. A repository set up by 1.x carries a
 * committed `.har/lib/verify-runner.mjs` (no stage-log capture) that verify
 * used to prefer; only an ejected harness still owns its copy.
 */

const ONE_X_RUNNER = '// verify-runner.mjs as HAR 1.x scaffolded it\nconsole.log("1.x");\n';

function scaffold(prefix: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  scaffoldHarnessBoilerplate(repo, { force: true, profile: 'cli' });
  return repo;
}

function runnerCopy(repo: string): string {
  return path.join(repo, '.har', 'lib', 'verify-runner.mjs');
}

/** Install a 1.x-style copy the manifest recorded as stock at its last finalize. */
function installOneXCopy(repo: string, content = ONE_X_RUNNER, recordAsStock = true): void {
  fs.mkdirSync(path.dirname(runnerCopy(repo)), { recursive: true });
  fs.writeFileSync(runnerCopy(repo), content);
  const manifest = readManifest(repo)!;
  writeManifest(repo, {
    ...manifest,
    templateChecksums: {
      ...(manifest.templateChecksums ?? {}),
      ...(recordAsStock ? { 'lib/verify-runner.mjs': computeFileChecksum(content) } : {}),
    },
  });
}

describe('stage runner after a 1.x → 2.0 upgrade', () => {
  it('a fresh 2.0 scaffold has no .har/lib runner copy', () => {
    const repo = scaffold('har-runner-fresh-');
    expect(fs.existsSync(runnerCopy(repo))).toBe(false);
    expect(resolveVerifyRunner(repo)).toBe(packagedVerifyRunner());
  });

  it('a stock 1.x copy is reported, ignored by verify and removed by maintain', async () => {
    const repo = scaffold('har-runner-stock-');
    installOneXCopy(repo);

    expect(findStaleRunnerCopy(repo)).toEqual({ file: 'lib/verify-runner.mjs', edited: false });
    expect(resolveVerifyRunner(repo)).toBe(packagedVerifyRunner());
    expect(runDoctor(repo).hints?.join('\n')).toContain('`har env maintain` removes it');

    const result = await maintainHarness({ repoPath: repo });
    expect(result.removedStaleRunner).toBe('lib/verify-runner.mjs');
    expect(fs.existsSync(runnerCopy(repo))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.har', 'lib'))).toBe(false);
    expect(result.doctor.hints ?? []).toEqual([]);
  });

  it('an edited copy is kept by maintain and doctor says how to resolve it', async () => {
    const repo = scaffold('har-runner-edited-');
    installOneXCopy(repo, '// my own runner\n', false);

    expect(findStaleRunnerCopy(repo)?.edited).toBe(true);
    const result = await maintainHarness({ repoPath: repo });
    expect(result.removedStaleRunner).toBeUndefined();
    expect(fs.readFileSync(runnerCopy(repo), 'utf8')).toBe('// my own runner\n');
    expect(result.doctor.hints?.join('\n')).toContain('har env eject');
    expect(result.doctor.ok).toBe(true);
  });

  it('removeStaleRunnerCopy keeps other files in .har/lib/', () => {
    const repo = scaffold('har-runner-lib-');
    installOneXCopy(repo);
    fs.writeFileSync(path.join(repo, '.har', 'lib', 'helper.sh'), 'true\n');
    expect(removeStaleRunnerCopy(repo)).toBe('lib/verify-runner.mjs');
    expect(fs.existsSync(path.join(repo, '.har', 'lib', 'helper.sh'))).toBe(true);
  });

  it('an ejected harness owns its copy: verify runs it, nothing reports or removes it', async () => {
    const repo = scaffold('har-runner-ejected-');
    process.env.HAR_EJECT_RUNTIME_SOURCE = packagedVerifyRunner();
    try {
      ejectHarness(repo);
    } finally {
      delete process.env.HAR_EJECT_RUNTIME_SOURCE;
    }
    // eject vendors the packaged runner
    expect(fs.readFileSync(runnerCopy(repo), 'utf8')).toBe(
      fs.readFileSync(packagedVerifyRunner(), 'utf8'),
    );
    expect(resolveVerifyRunner(repo)).toBe(runnerCopy(repo));
    expect(findStaleRunnerCopy(repo)).toBeNull();

    const result = await maintainHarness({ repoPath: repo });
    expect(result.removedStaleRunner).toBeUndefined();
    expect(fs.existsSync(runnerCopy(repo))).toBe(true);

    adoptHarness(repo);
    expect(fs.existsSync(runnerCopy(repo))).toBe(false);
    expect(resolveVerifyRunner(repo)).toBe(packagedVerifyRunner());
  });

  it('eject keeps a copy the repository already owns', () => {
    const repo = scaffold('har-runner-eject-keep-');
    installOneXCopy(repo, '// mine\n', false);
    process.env.HAR_EJECT_RUNTIME_SOURCE = packagedVerifyRunner();
    try {
      ejectHarness(repo);
    } finally {
      delete process.env.HAR_EJECT_RUNTIME_SOURCE;
    }
    expect(fs.readFileSync(runnerCopy(repo), 'utf8')).toBe('// mine\n');
    expect(resolveVerifyRunner(repo)).toBe(runnerCopy(repo));
  });
});

describe('maintain keeps the verification plan', () => {
  it('never adds ecosystem default stages to an upgraded project', async () => {
    const repo = scaffold('har-maintain-plan-');
    fs.writeFileSync(
      path.join(repo, 'package.json'),
      JSON.stringify({ name: 'p', scripts: { test: 'jest', lint: 'eslint .', typecheck: 'tsc' } }),
    );
    const stagesPath = path.join(repo, '.har', 'stages.json');
    const registry = JSON.parse(fs.readFileSync(stagesPath, 'utf8'));
    // The project's own plan (as a 1.x repo had it): no typecheck/unit-tests/lint.
    const custom = {
      ...registry,
      verificationStages: ['big-output'],
      stages: [
        ...registry.stages.filter(
          (s: { id: string }) => !['typecheck', 'unit-tests', 'lint'].includes(s.id),
        ),
        { id: 'big-output', kind: 'test', tier: 'full', command: 'echo big' },
      ],
    };
    const before = JSON.stringify(custom, null, 2) + '\n';
    fs.writeFileSync(stagesPath, before);

    await maintainHarness({ repoPath: repo });
    expect(fs.readFileSync(stagesPath, 'utf8')).toBe(before);

    await maintainHarness({ repoPath: repo, finalize: true });
    expect(JSON.parse(fs.readFileSync(stagesPath, 'utf8')).verificationStages).toEqual([
      'big-output',
    ]);
  });
});
