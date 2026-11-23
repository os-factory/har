import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Node toolchain pinning, end to end: the built CLI launches real slots (git
 * worktrees under a sandbox HOME) of repositories whose harness needs a newer
 * Node than the one on PATH, and the stage really runs on the pinned one.
 *
 * Installs are fake nvm versions (`<NVM_DIR>/versions/node/vX/bin/node`): tiny
 * wrappers that export HAR_E2E_NODE=<version> and exec the real node, so a
 * stage's `node` proves which install it resolved (process.execPath would
 * point at the real binary either way). No Docker, no pm2 (cli profile).
 *
 * Opt-in:
 *   npm run build && HAR_NODE_TOOLCHAIN_E2E=1 npx jest tests/node-toolchain.e2e.test.ts --forceExit
 */

const ROOT = path.resolve(__dirname, '..');
const HAR_BIN = path.join(ROOT, 'dist', 'index.js');
const run = process.env.HAR_NODE_TOOLCHAIN_E2E === '1' ? describe : describe.skip;

const REAL_NODE = process.execPath;
const REAL_BIN_DIR = path.dirname(REAL_NODE);
const REAL_NPM = path.join(REAL_BIN_DIR, 'npm');

/** Writes the observed node (wrapper marker, version) to the file named by argv[1]. */
const PROBE =
  'node -e "require(\'fs\').writeFileSync(process.argv[1], JSON.stringify({ wrapper: process.env.HAR_E2E_NODE || null, npm: process.env.HAR_E2E_NPM || null, version: process.version }))"';

interface Probe {
  wrapper: string | null;
  npm: string | null;
  version: string;
}

run('node toolchain pinning end to end: built CLI → launch → stage', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'har-node-e2e-'));
  const home = path.join(base, 'home');
  const nvmDir = path.join(base, 'nvm');
  const binDir = (version: string) => path.join(nvmDir, 'versions', 'node', version, 'bin');

  const env = (): NodeJS.ProcessEnv => {
    const e: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      NVM_DIR: nvmDir,
      PM2_HOME: path.join(base, '.pm2'),
      // The real node first on PATH, so "the PATH node" is deterministic.
      PATH: `${REAL_BIN_DIR}${path.delimiter}${process.env.PATH ?? ''}`,
      HAR_TELEMETRY: 'off',
      HAR_SKIP_TELEMETRY_POSTINSTALL: '1',
      NODE_ENV: 'production',
      GIT_AUTHOR_NAME: 'e2e',
      GIT_AUTHOR_EMAIL: 'e2e@example.com',
      GIT_COMMITTER_NAME: 'e2e',
      GIT_COMMITTER_EMAIL: 'e2e@example.com',
    };
    for (const key of Object.keys(e)) {
      if (
        ['FNM_DIR', 'FNM_MULTISHELL_PATH', 'VOLTA_HOME', 'N_PREFIX', 'NVM_BIN', 'HAR_E2E_NODE', 'HAR_E2E_NPM'].includes(
          key,
        ) ||
        key.startsWith('MISE_') ||
        key.startsWith('ASDF_')
      ) {
        delete e[key];
      }
    }
    return e;
  };

  /** Runs the built CLI; returns combined output, throws with it on failure. */
  const har = (cwd: string, ...args: string[]): string => {
    const result = spawnSync(REAL_NODE, [HAR_BIN, ...args], {
      cwd,
      env: env(),
      encoding: 'utf8',
      timeout: 240_000,
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0) {
      throw new Error(`har ${args.join(' ')} exited ${result.status}\n${output}`);
    }
    return output;
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, env: env(), encoding: 'utf8' });

  function fakeInstall(version: string): void {
    fs.mkdirSync(binDir(version), { recursive: true });
    const wrap = (name: string, marker: string, target: string) => {
      const file = path.join(binDir(version), name);
      fs.writeFileSync(file, `#!/bin/sh\nexport ${marker}=${version}\nexec "${target}" "$@"\n`);
      fs.chmodSync(file, 0o755);
    };
    wrap('node', 'HAR_E2E_NODE', REAL_NODE);
    if (fs.existsSync(REAL_NPM)) wrap('npm', 'HAR_E2E_NPM', REAL_NPM);
  }

  /** A git repo with a cli-profile harness whose only verify stage is the probe in web/. */
  function initRepo(name: string, rootEngines: string | null, webEngines: string | null): string {
    const repo = path.join(base, name);
    fs.mkdirSync(path.join(repo, 'web'), { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    const pkg: Record<string, unknown> = {
      name,
      version: '1.0.0',
      private: true,
      scripts: { postinstall: PROBE.replace('process.argv[1]', "'install-proof.json'") },
    };
    if (rootEngines) pkg.engines = { node: rootEngines };
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify(pkg, null, 2));
    const web: Record<string, unknown> = { name: `${name}-web`, version: '1.0.0', private: true };
    if (webEngines) web.engines = { node: webEngines };
    fs.writeFileSync(path.join(repo, 'web', 'package.json'), JSON.stringify(web, null, 2));
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'init');

    har(repo, 'env', 'init', '--profile', 'cli', '--yes', '--no-cursor-rule', '--no-agents', '--commit-gate', 'never');
    const stagesPath = path.join(repo, '.har', 'stages.json');
    const stages = JSON.parse(fs.readFileSync(stagesPath, 'utf8'));
    stages.stages = stages.stages.filter((s: { kind: string }) => s.kind !== 'test');
    stages.stages.push({
      id: 'which-node',
      kind: 'test',
      tier: 'quick',
      description: 'Records which node a stage command resolves from web/',
      command: `cd web && ${PROBE.replace('process.argv[1]', "'../stage-proof.json'")}`,
      requiresAgentId: true,
    });
    stages.verificationStages = ['which-node'];
    fs.writeFileSync(stagesPath, JSON.stringify(stages, null, 2));

    // Lifecycle hooks get the process env plus ENV_FILE, not the slot env.
    const hook = path.join(repo, '.har', 'hooks', 'post-launch.sh');
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(
      hook,
      [
        '#!/usr/bin/env bash',
        'set -e',
        PROBE.replace('process.argv[1]', "'hook-bare.json'"),
        `( set -a; . "$ENV_FILE"; set +a; ${PROBE.replace('process.argv[1]', "'hook-sourced.json'")} )`,
        '',
      ].join('\n'),
    );
    fs.chmodSync(hook, 0o755);
    const preVerify = path.join(repo, '.har', 'hooks', 'pre-verify.sh');
    fs.writeFileSync(preVerify, `#!/usr/bin/env bash\n${PROBE.replace('process.argv[1]', "'pre-verify.json'")}\n`);
    fs.chmodSync(preVerify, 0o755);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'har');
    return repo;
  }

  const workDirOf = (output: string): string => {
    const m = output.match(/make ALL file edits under: (\S+)/);
    if (!m) throw new Error(`no work dir in launch output:\n${output}`);
    return m[1];
  };
  const readEnvValue = (envFile: string, key: string): string | undefined => {
    const lines = fs.readFileSync(envFile, 'utf8').split('\n');
    const line = lines.reverse().find((l) => l.startsWith(`${key}=`));
    return line?.slice(key.length + 1).replace(/^'(.*)'$/, '$1');
  };
  const probe = (file: string): Probe => JSON.parse(fs.readFileSync(file, 'utf8'));
  const doctor = (repo: string) => JSON.parse(har(repo, 'env', 'doctor', '--json', '--repo', repo));
  const nodeCheck = (report: { checks: Array<{ id: string; status: string; details?: string[] }> }) =>
    report.checks.find((c) => c.id === 'node-toolchain');

  const launched: string[] = [];
  const launch = (repo: string): { output: string; workDir: string; envFile: string } => {
    const output = har(repo, 'env', 'launch', '1', '--repo', repo);
    launched.push(repo);
    const workDir = workDirOf(output);
    return { output, workDir, envFile: path.join(workDir, '.env.agent.1') };
  };
  const teardown = (repo: string) => {
    const i = launched.indexOf(repo);
    if (i === -1) return;
    launched.splice(i, 1);
    har(repo, 'env', 'teardown', '1', '--repo', repo);
  };

  beforeAll(() => {
    expect(fs.existsSync(HAR_BIN)).toBe(true);
    fakeInstall('v99.0.0');
    fakeInstall('v18.0.0'); // decoy: older than PATH node, satisfies nothing
  });

  afterAll(() => {
    for (const repo of [...launched]) {
      try {
        teardown(repo);
      } catch {
        // best effort — the temp dir goes regardless
      }
    }
    fs.rmSync(base, { recursive: true, force: true });
  });

  describe('engines >=20 at the root and >=99 in a dir a stage cds into', () => {
    let repo = '';
    let slot: { output: string; workDir: string; envFile: string };

    beforeAll(() => {
      repo = initRepo('pinned', '>=20', '>=99');
      slot = launch(repo);
    });
    afterAll(() => teardown(repo));

    it('launch pins the installed v99 and says why', () => {
      expect(slot.output).toMatch(
        new RegExp(
          `toolchain: node v99\\.0\\.0 \\(nvm\\) — PATH ${process.version.replace(/\./g, '\\.')} does not satisfy >=99 \\(web/package\\.json engines\\.node\\)`,
        ),
      );
      expect(slot.output).not.toContain('WARNING: no installed Node');

      expect(readEnvValue(slot.envFile, 'NODE_BIN')).toBe(path.join(binDir('v99.0.0'), 'node'));
      if (fs.existsSync(REAL_NPM)) {
        expect(readEnvValue(slot.envFile, 'NPM_BIN')).toBe(path.join(binDir('v99.0.0'), 'npm'));
      }
      // The pinned dir leads PATH (node_modules/.bin is only added when it exists).
      const pathEntries = (readEnvValue(slot.envFile, 'PATH') ?? '')
        .split(path.delimiter)
        .filter((p) => p !== path.join(slot.workDir, 'node_modules', '.bin'));
      expect(pathEntries[0]).toBe(binDir('v99.0.0'));
      expect(pathEntries.indexOf(binDir('v99.0.0'))).toBeLessThan(pathEntries.indexOf(REAL_BIN_DIR));
      expect(pathEntries).not.toContain(binDir('v18.0.0'));
    });

    it('the dependency install ran on the pinned node (and pinned npm)', () => {
      const install = probe(path.join(slot.workDir, 'install-proof.json'));
      expect(install.wrapper).toBe('v99.0.0');
      if (fs.existsSync(REAL_NPM)) expect(install.npm).toBe('v99.0.0');
    });

    it('run-stage and verify execute the stage in the work dir on the pinned node', () => {
      const proof = path.join(slot.workDir, 'stage-proof.json');
      // Regression: run-stage ran project stages from the main checkout with
      // the caller's env — wrong tree, PATH node.
      har(repo, 'env', 'run-stage', '1', 'which-node', '--repo', repo);
      expect(fs.existsSync(path.join(repo, 'stage-proof.json'))).toBe(false);
      expect(probe(proof).wrapper).toBe('v99.0.0');

      fs.rmSync(proof);
      const verify = har(repo, 'env', 'verify', '1', '--repo', repo);
      expect(verify).toMatch(/which-node.*✓/);
      expect(probe(proof).wrapper).toBe('v99.0.0');
      // verify sources the slot env before its pre-verify hook.
      expect(probe(path.join(slot.workDir, 'pre-verify.json')).wrapper).toBe('v99.0.0');
    });

    it('known limitation: a post-launch hook runs the PATH node unless it sources $ENV_FILE', () => {
      expect(slot.output).toContain('Running .har/hooks/post-launch.sh');
      expect(probe(path.join(slot.workDir, 'hook-bare.json')).wrapper).toBeNull();
      expect(probe(path.join(slot.workDir, 'hook-sourced.json')).wrapper).toBe('v99.0.0');
    });

    it('doctor lists both sources and reports slot 1 satisfying', () => {
      const report = doctor(repo);
      const check = nodeCheck(report);
      expect(check?.status).toBe('pass');
      expect(report.nodeToolchain.constraint).toBe(
        '>=20 (package.json engines.node) and >=99 (web/package.json engines.node)',
      );
      expect(report.nodeToolchain.choice).toBe('pinned');
      expect(report.nodeToolchain.nextLaunch).toEqual(
        expect.objectContaining({ version: 'v99.0.0', source: 'nvm' }),
      );
      expect(report.nodeToolchain.slots).toEqual([
        expect.objectContaining({
          agentId: 1,
          nodeBin: path.join(binDir('v99.0.0'), 'node'),
          version: 'v99.0.0',
          satisfies: true,
        }),
      ]);
      expect(report.nodeToolchain.slots[0].pathNode).toBeUndefined();
    });

    it('doctor warns once the env file runs the PATH node again', () => {
      const original = fs.readFileSync(slot.envFile, 'utf8');
      try {
        // Only PATH reverted: NODE_BIN still says v99, but stages would run the PATH node.
        fs.writeFileSync(slot.envFile, original.split(`${binDir('v99.0.0')}${path.delimiter}`).join(''));
        let report = doctor(repo);
        expect(nodeCheck(report)?.status).toBe('warn');
        expect(report.nodeToolchain.slots[0]).toEqual(
          expect.objectContaining({
            version: 'v99.0.0',
            pathNode: { nodeBin: REAL_NODE, version: process.version },
            satisfies: false,
          }),
        );
        let finding = report.findings.find((f: { check: string }) => f.check === 'node-toolchain');
        expect(finding.message).toContain(`its PATH resolves \`node\` to ${process.version}`);
        fs.rmSync(path.join(slot.workDir, 'stage-proof.json'), { force: true });
        har(repo, 'env', 'run-stage', '1', 'which-node', '--repo', repo);
        expect(probe(path.join(slot.workDir, 'stage-proof.json')).wrapper).toBeNull();

        // NODE_BIN reverted too.
        fs.writeFileSync(
          slot.envFile,
          fs
            .readFileSync(slot.envFile, 'utf8')
            .replace(/^NODE_BIN=.*$/m, `NODE_BIN=${REAL_NODE}`),
        );
        report = doctor(repo);
        expect(nodeCheck(report)?.status).toBe('warn');
        expect(report.ok).toBe(true); // warn-only, never blocks
        expect(report.nodeToolchain.slots).toEqual([
          expect.objectContaining({ agentId: 1, nodeBin: REAL_NODE, version: process.version, satisfies: false }),
        ]);
        finding = report.findings.find((f: { check: string }) => f.check === 'node-toolchain');
        expect(finding.severity).toBe('warning');
        expect(finding.message).toBe(
          `Slot 1 pins node ${process.version}, which does not satisfy >=99 (web/package.json engines.node)`,
        );
        expect(finding.remedy).toContain('Relaunch the slot (`har env complete 1` / `teardown`, then `har env launch 1`) so it pins v99.0.0');
        expect(finding.remedy).toContain(`set NODE_BIN=${path.join(binDir('v99.0.0'), 'node')}`);
        expect(finding.remedy).toContain(`prepend ${binDir('v99.0.0')}: to PATH`);
      } finally {
        fs.writeFileSync(slot.envFile, original);
      }
    });
  });

  it('nothing installed satisfies >=999: launch still succeeds, warns, keeps the PATH node', () => {
    const repo = initRepo('unsatisfied', '>=20', '>=999');
    try {
      const slot = launch(repo);
      expect(slot.output).toContain('WARNING: no installed Node satisfies');
      expect(slot.output).toMatch(/→ .*nvm install/);
      expect(readEnvValue(slot.envFile, 'NODE_BIN')).toBe(REAL_NODE);
      expect(readEnvValue(slot.envFile, 'PATH') ?? '').not.toContain(nvmDir);

      har(repo, 'env', 'run-stage', '1', 'which-node', '--repo', repo);
      expect(probe(path.join(slot.workDir, 'stage-proof.json'))).toEqual(
        expect.objectContaining({ wrapper: null, version: process.version }),
      );
      const report = doctor(repo);
      expect(report.nodeToolchain.choice).toBe('unsatisfied');
      expect(nodeCheck(report)?.status).toBe('warn');
    } finally {
      teardown(repo);
    }
  });

  it('no Node requirement: NODE_BIN is the PATH node and no toolchain line (unchanged)', () => {
    const repo = initRepo('plain', null, null);
    try {
      const slot = launch(repo);
      expect(slot.output).not.toMatch(/toolchain: node v/);
      expect(slot.output).not.toContain('no installed Node satisfies');
      expect(readEnvValue(slot.envFile, 'NODE_BIN')).toBe(REAL_NODE);
      expect(readEnvValue(slot.envFile, 'PATH') ?? '').not.toContain(nvmDir);
      expect(probe(path.join(slot.workDir, 'install-proof.json')).wrapper).toBeNull();
      const report = doctor(repo);
      expect(nodeCheck(report)?.status).toBe('skip');
      expect(report.nodeToolchain).toBeUndefined();
    } finally {
      teardown(repo);
    }
  });
});
