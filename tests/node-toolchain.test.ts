import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { formatDoctorReport, runDoctor } from '../src/harness/doctor';
import {
  collectNodeRequirements,
  nodeInstallHint,
  planNodeToolchain,
} from '../src/harness/node-toolchain';
import { ExecResult, SystemOps } from '../src/runtime/exec';
import { provisionToolchain } from '../src/runtime/provision';
import { listInstalledNodes, nodeVersionFromPath } from '../src/utils/node-installs';
import { maxSatisfyingAll, parseRange, satisfiesRange } from '../src/utils/semver';

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** Fake `bin/node` (+ npm) under `<root>/<version>/<binRel>` — never executed. */
function fakeNode(root: string, versionDir: string, binRel = 'bin'): string {
  const binDir = path.join(root, versionDir, binRel);
  fs.mkdirSync(binDir, { recursive: true });
  for (const name of ['node', 'npm']) {
    fs.writeFileSync(path.join(binDir, name), '#!/bin/sh\nexit 99\n');
    fs.chmodSync(path.join(binDir, name), 0o755);
  }
  return path.join(binDir, 'node');
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

describe('utils/semver range matching', () => {
  it.each([
    ['22.23.4', '>=22.23.4', true],
    ['22.22.2', '>=22.23.4', false],
    ['24.14.0', '>=20', true],
    ['20.0.0', '>20', false],
    ['21.0.0', '>20', true],
    ['20.5.0', '<21', true],
    ['21.0.0', '<21', false],
    ['20.9.9', '<=20', true],
    ['21.0.0', '<=20', false],
    ['20.19.0', '^20.10.0', true],
    ['21.0.0', '^20.10.0', false],
    ['0.2.5', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['20.10.9', '~20.10.1', true],
    ['20.11.0', '~20.10.1', false],
    ['22.1.0', '22.x', true],
    ['23.0.0', '22.x', false],
    ['22.9.0', '22', true],
    ['22.12.0', '22.12.0', true],
    ['22.12.1', '22.12.0', false],
    ['v22.12.0', '=22.12.0', true],
    ['18.0.0', '*', true],
    ['20.1.0', '^18 || ^20', true],
    ['19.1.0', '^18 || ^20', false],
    ['20.5.0', '>=20.0.0 <21.0.0', true],
    ['21.5.0', '>=20.0.0 <21.0.0', false],
    ['21.5.0', '20 - 22', true],
    ['23.0.0', '20 - 22', false],
    ['22.0.0', '>= 20', true],
  ])('%s satisfies %s → %s', (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });

  it('rejects ranges it does not understand', () => {
    expect(parseRange('lts/*')).toBeNull();
    expect(satisfiesRange('22.0.0', 'banana')).toBe(false);
  });

  it('picks the highest version satisfying every range', () => {
    const versions = ['v20.19.6', 'v22.22.2', 'v24.13.0', 'v24.14.0'];
    expect(maxSatisfyingAll(versions, ['>=20', '>=22.23.4'])).toBe('v24.14.0');
    expect(maxSatisfyingAll(versions, ['^22'])).toBe('v22.22.2');
    expect(maxSatisfyingAll(versions, ['>=26'])).toBeNull();
  });
});

describe('collectNodeRequirements', () => {
  it('combines root engines, .nvmrc, workspaces and stage/hook directories', () => {
    const root = tmp('har-node-req-');
    writeJson(path.join(root, 'package.json'), {
      engines: { node: '>=20' },
      volta: { node: '22.12.0' },
      workspaces: ['packages/*'],
    });
    fs.writeFileSync(path.join(root, '.nvmrc'), 'lts/jod\n');
    writeJson(path.join(root, 'packages', 'lib', 'package.json'), { engines: { node: '^22' } });
    writeJson(path.join(root, 'docs', 'package.json'), { engines: { node: '>=22.23.4' } });
    writeJson(path.join(root, 'site', 'package.json'), { engines: { node: '<26' } });
    writeJson(path.join(root, 'untouched', 'package.json'), { engines: { node: '>=99' } });
    writeJson(path.join(root, '.har', 'stages.json'), {
      version: '1',
      verificationStages: ['docs-build'],
      stages: [
        { id: 'launch', kind: 'launch' },
        { id: 'docs-build', kind: 'test', command: '(cd docs && ${NPM_BIN:-npm} run build)' },
      ],
    });
    fs.mkdirSync(path.join(root, '.har', 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.har', 'hooks', 'post-launch.sh'),
      '#!/usr/bin/env bash\n(cd "$WORK_DIR/site" && npm install)\n',
    );

    const { requirements, ignored } = collectNodeRequirements(root);
    expect(requirements).toEqual(
      expect.arrayContaining([
        { source: 'package.json', field: 'engines.node', range: '>=20' },
        { source: 'package.json', field: 'volta.node', range: '22.12.0' },
        { source: '.nvmrc', field: '.nvmrc', range: '22' },
        { source: path.join('packages', 'lib', 'package.json'), field: 'engines.node', range: '^22' },
        { source: path.join('docs', 'package.json'), field: 'engines.node', range: '>=22.23.4' },
        { source: path.join('site', 'package.json'), field: 'engines.node', range: '<26' },
      ]),
    );
    expect(requirements.some((r) => r.range === '>=99')).toBe(false);
    expect(ignored).toEqual([]);
  });

  it('reports unparseable version files as ignored', () => {
    const root = tmp('har-node-req-');
    fs.writeFileSync(path.join(root, '.node-version'), 'lts/*\n');
    const { requirements, ignored } = collectNodeRequirements(root);
    expect(requirements).toEqual([]);
    expect(ignored).toHaveLength(1);
    expect(ignored[0].source).toBe('.node-version');
  });

  it('suggests an install target', () => {
    expect(nodeInstallHint([{ source: 'package.json', field: 'engines.node', range: '>=22.23.4 <25' }])).toBe('22');
    expect(nodeInstallHint([{ source: 'package.json', field: 'engines.node', range: '~22.1' }])).toBe('22.1');
  });
});

describe('installed Node discovery', () => {
  it('lists nvm, fnm, volta, mise and asdf installs from directory names only', () => {
    const home = tmp('har-node-home-');
    fakeNode(path.join(home, '.nvm', 'versions', 'node'), 'v22.22.2');
    fakeNode(path.join(home, '.nvm', 'versions', 'node'), 'v24.14.0');
    fakeNode(path.join(home, '.local', 'share', 'fnm', 'node-versions'), 'v20.19.6', path.join('installation', 'bin'));
    fakeNode(path.join(home, '.volta', 'tools', 'image', 'node'), '18.20.0');
    fakeNode(path.join(home, '.local', 'share', 'mise', 'installs', 'node'), '23.1.0');
    fs.symlinkSync('./23.1.0', path.join(home, '.local', 'share', 'mise', 'installs', 'node', '23'));
    fakeNode(path.join(home, '.asdf', 'installs', 'nodejs'), '21.7.3');
    fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', 'v19.0.0')); // no bin/node → ignored

    const installs = listInstalledNodes({ env: { N_PREFIX: path.join(home, 'none') }, home });
    expect(installs.map((i) => `${i.source}:${i.version}`).sort()).toEqual([
      'asdf:v21.7.3',
      'fnm:v20.19.6',
      'mise:v23.1.0',
      'nvm:v22.22.2',
      'nvm:v24.14.0',
      'volta:v18.20.0',
    ]);
    expect(nodeVersionFromPath(path.join(home, '.nvm', 'versions', 'node', 'v24.14.0', 'bin', 'node'))).toBe('v24.14.0');
  });
});

/** A harness root needing >=22.23.4 (via docs/), plus a fake nvm with 22.22.2 and 24.14.0. */
function nodeFixture(): { root: string; home: string; nvm: string; pathNode: string } {
  const root = tmp('har-node-root-');
  const home = tmp('har-node-home-');
  writeJson(path.join(root, 'package.json'), { name: 'fixture', engines: { node: '>=20' } });
  writeJson(path.join(root, 'docs', 'package.json'), { engines: { node: '>=22.23.4' } });
  writeJson(path.join(root, '.har', 'stages.json'), {
    version: '1',
    agentSlots: { min: 1, max: 3 },
    verificationStages: ['docs-build'],
    stages: [
      { id: 'launch', kind: 'launch' },
      { id: 'verify', kind: 'verify' },
      { id: 'teardown', kind: 'teardown' },
      { id: 'docs-build', kind: 'test', tier: 'quick', command: '(cd docs && npm run build)' },
    ],
  });
  const nvm = path.join(home, '.nvm', 'versions', 'node');
  const pathNode = fakeNode(nvm, 'v22.22.2');
  fakeNode(nvm, 'v24.13.0');
  fakeNode(nvm, 'v24.14.0');
  return { root, home, nvm, pathNode };
}

const discovery = (home: string) => ({ env: { HOME: home, N_PREFIX: path.join(home, 'none') }, home });

describe('planNodeToolchain', () => {
  it('pins the highest installed Node that satisfies every requirement', () => {
    const { root, home, pathNode } = nodeFixture();
    const plan = planNodeToolchain(root, { ...discovery(home), pathNodeBin: pathNode });
    expect(plan.choice).toBe('pinned');
    expect(plan.node?.version).toBe('v24.14.0');
    expect(plan.summary).toBe(
      `node v24.14.0 (nvm) — PATH v22.22.2 does not satisfy >=22.23.4 (${path.join('docs', 'package.json')} engines.node)`,
    );
  });

  it('keeps the PATH node when it satisfies', () => {
    const { root, home, nvm } = nodeFixture();
    const plan = planNodeToolchain(root, {
      ...discovery(home),
      pathNodeBin: path.join(nvm, 'v24.13.0', 'bin', 'node'),
    });
    expect(plan.choice).toBe('path');
    expect(plan.node?.version).toBe('v24.13.0');
  });

  it('warns with a remedy when nothing installed satisfies', () => {
    const { root, home, nvm, pathNode } = nodeFixture();
    fs.rmSync(path.join(nvm, 'v24.13.0'), { recursive: true });
    fs.rmSync(path.join(nvm, 'v24.14.0'), { recursive: true });
    const plan = planNodeToolchain(root, { ...discovery(home), pathNodeBin: pathNode });
    expect(plan.choice).toBe('unsatisfied');
    expect(plan.node?.nodeBin).toBe(pathNode);
    expect(plan.remedy).toContain('`nvm install 22`');
    expect(plan.remedy).toContain('`fnm install 22`');
  });
});

describe('launch provisioning pins the Node', () => {
  function fakeOps(pathNode: string): SystemOps & { envs: (NodeJS.ProcessEnv | undefined)[] } {
    const envs: (NodeJS.ProcessEnv | undefined)[] = [];
    const ok: ExecResult = { code: 0, stdout: '', stderr: '' };
    return {
      envs,
      which: (cmd) => (cmd === 'node' ? pathNode : cmd === 'npm' ? '/usr/bin/npm' : null),
      async run(_cmd, _args, opts) {
        envs.push(opts?.env);
        return ok;
      },
      async runShell() {
        return ok;
      },
      async capture() {
        return null;
      },
    };
  }

  it('writes the pinned NODE_BIN / NPM_BIN / PATH and installs with it', async () => {
    const { root, home, nvm, pathNode } = nodeFixture();
    fs.mkdirSync(path.join(root, 'node_modules', '.bin'), { recursive: true });
    const envFile = path.join(root, '.env.agent.1');
    fs.writeFileSync(envFile, '');
    const logs: string[] = [];
    const ops = fakeOps(pathNode);
    await provisionToolchain({
      workDir: root,
      envFile,
      ops,
      nodeDiscovery: discovery(home),
      log: (m) => logs.push(m),
    });
    const pinned = path.join(nvm, 'v24.14.0', 'bin');
    const env = fs.readFileSync(envFile, 'utf8');
    expect(env).toContain(`NODE_BIN=${pinned}/node\n`);
    expect(env).toContain(`NPM_BIN=${pinned}/npm\n`);
    expect(env).toContain(`PATH=${path.join(root, 'node_modules', '.bin')}:${pinned}:`);
    expect(logs).toContain(
      `node v24.14.0 (nvm) — PATH v22.22.2 does not satisfy >=22.23.4 (${path.join('docs', 'package.json')} engines.node)`,
    );
    expect(ops.envs[0]?.PATH?.startsWith(`${pinned}:`)).toBe(true);
  });

  it('keeps the PATH node and warns when nothing satisfies', async () => {
    const { root, home, nvm, pathNode } = nodeFixture();
    fs.rmSync(path.join(nvm, 'v24.13.0'), { recursive: true });
    fs.rmSync(path.join(nvm, 'v24.14.0'), { recursive: true });
    const envFile = path.join(root, '.env.agent.1');
    fs.writeFileSync(envFile, '');
    const logs: string[] = [];
    const ops = fakeOps(pathNode);
    await provisionToolchain({ workDir: root, envFile, ops, nodeDiscovery: discovery(home), log: (m) => logs.push(m) });
    expect(fs.readFileSync(envFile, 'utf8')).toContain(`NODE_BIN=${pathNode}\n`);
    expect(logs.some((l) => l.startsWith('WARNING: no installed Node satisfies'))).toBe(true);
    expect(logs.some((l) => l.includes('nvm install'))).toBe(true);
    expect(ops.envs[0]).toBeUndefined();
  });
});

describe('doctor node-toolchain check', () => {
  it('reports the constraint, the next pin, and slots pinned to an unsatisfying Node', () => {
    const { root, home, nvm, pathNode } = nodeFixture();
    const workDir = tmp('har-node-slot-');
    fs.writeFileSync(path.join(workDir, '.env.agent.2'), `NODE_BIN=${pathNode}\nNPM_BIN=/usr/bin/npm\n`);
    writeJson(path.join(root, '.har', 'slots', 'agent-2.json'), {
      version: 1,
      agentId: 2,
      projectName: 'fixture',
      mode: 'worktree',
      workDir,
      status: 'active',
      createdAt: new Date().toISOString(),
    });

    const report = runDoctor(root, { node: { ...discovery(home), pathNodeBin: pathNode } });
    const check = report.checks.find((c) => c.id === 'node-toolchain');
    expect(check?.status).toBe('warn');
    // Severity warn, never error: it must not block launch.
    expect(report.findings.filter((f) => f.check === 'node-toolchain' && f.severity === 'error')).toEqual([]);
    expect(report.nodeToolchain?.constraint).toBe(
      `>=20 (package.json engines.node) and >=22.23.4 (${path.join('docs', 'package.json')} engines.node)`,
    );
    expect(report.nodeToolchain?.nextLaunch?.version).toBe('v24.14.0');
    expect(report.nodeToolchain?.slots).toEqual([
      expect.objectContaining({ agentId: 2, version: 'v22.22.2', satisfies: false }),
    ]);
    const finding = report.findings.find((f) => f.check === 'node-toolchain');
    expect(finding?.severity).toBe('warning');
    expect(finding?.message).toContain('Slot 2 pins node v22.22.2');
    expect(finding?.remedy).toContain(`NODE_BIN=${path.join(nvm, 'v24.14.0', 'bin', 'node')}`);

    const text = formatDoctorReport(report);
    expect(text).toContain('· constraint: >=20 (package.json engines.node)');
    expect(text).toContain('· next launch pins: v24.14.0 (nvm,');
  });

  it('flags a slot whose NODE_BIN satisfies but whose PATH runs an older node', () => {
    const { root, home, nvm, pathNode } = nodeFixture();
    const pinned = path.join(nvm, 'v24.14.0', 'bin', 'node');
    const workDir = tmp('har-node-slot-');
    fs.writeFileSync(
      path.join(workDir, '.env.agent.1'),
      `NODE_BIN=${pinned}\nPATH=${path.dirname(pathNode)}:/usr/bin\n`,
    );
    writeJson(path.join(root, '.har', 'slots', 'agent-1.json'), {
      version: 1,
      agentId: 1,
      projectName: 'fixture',
      mode: 'worktree',
      workDir,
      status: 'active',
      createdAt: new Date().toISOString(),
    });

    const report = runDoctor(root, { node: { ...discovery(home), pathNodeBin: pathNode } });
    expect(report.nodeToolchain?.slots).toEqual([
      expect.objectContaining({
        agentId: 1,
        version: 'v24.14.0',
        pathNode: { nodeBin: pathNode, version: 'v22.22.2' },
        satisfies: false,
      }),
    ]);
    const finding = report.findings.find((f) => f.check === 'node-toolchain');
    expect(finding?.message).toContain('its PATH resolves `node` to v22.22.2');
    expect(finding?.remedy).toContain(`prepend ${path.join(nvm, 'v24.14.0', 'bin')}: to PATH`);
    expect(formatDoctorReport(report)).toContain(`PATH node v22.22.2 (${pathNode})`);

    // Pinned dir first on PATH: NODE_BIN and the stage node are the same binary.
    fs.writeFileSync(
      path.join(workDir, '.env.agent.1'),
      `NODE_BIN=${pinned}\nPATH=${path.dirname(pinned)}:${path.dirname(pathNode)}\n`,
    );
    const fixed = runDoctor(root, { node: { ...discovery(home), pathNodeBin: pathNode } });
    expect(fixed.nodeToolchain?.slots).toEqual([
      { agentId: 1, envFile: path.join(workDir, '.env.agent.1'), nodeBin: pinned, version: 'v24.14.0', satisfies: true },
    ]);
  });

  it('skips when the harness declares no Node requirement', () => {
    const root = tmp('har-node-none-');
    fs.mkdirSync(path.join(root, '.har'));
    const report = runDoctor(root, { node: { pathNodeBin: null, installed: [] } });
    expect(report.checks.find((c) => c.id === 'node-toolchain')?.status).toBe('skip');
    expect(report.nodeToolchain).toBeUndefined();
  });
});
