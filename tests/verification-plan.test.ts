import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { HarnessStageRegistrySchema } from '../src/harness/schema';
import {
  deriveEcosystemDefaultStages,
  ensureEcosystemVerificationStages,
  findPhantomVerificationStageIds,
  resolveVerificationPlan,
} from '../src/harness/verification';

const RUNNER = path.join(
  __dirname,
  '..',
  'src',
  'templates',
  'runtime-bundles',
  'shared-kernel',
  'lib',
  'verify-runner.mjs',
);

function makeRegistry(overrides: Record<string, unknown>) {
  return HarnessStageRegistrySchema.parse({
    version: '1',
    agentSlots: { min: 1, max: 3 },
    stages: [],
    ...overrides,
  });
}

describe('resolveVerificationPlan', () => {
  const registry = makeRegistry({
    verificationStages: ['b', 'a', 'ghost', 'c'],
    stages: [
      { id: 'a', kind: 'test', tier: 'quick', command: 'true' },
      { id: 'b', kind: 'test', tier: 'full', command: 'true' },
      { id: 'c', kind: 'custom', command: 'true' },
      { id: 'verify', kind: 'verify', command: './.har/verify.sh {agentId}' },
    ],
  });

  it('honors verificationStages order and resolves every id', () => {
    const plan = resolveVerificationPlan(registry, { full: true });
    expect(plan.steps.map((s) => s.id)).toEqual(['b', 'a', 'c']);
    expect(plan.phantomIds).toEqual(['ghost']);
  });

  it('quick mode keeps only tier "quick" stages', () => {
    const plan = resolveVerificationPlan(registry, { full: false });
    expect(plan.steps.map((s) => s.id)).toEqual(['a']);
  });

  it('treats non-runnable kinds as phantoms', () => {
    const reg = makeRegistry({
      verificationStages: ['verify'],
      stages: [{ id: 'verify', kind: 'verify', command: './.har/verify.sh {agentId}' }],
    });
    expect(findPhantomVerificationStageIds(reg)).toEqual(['verify']);
  });
});

describe('deriveEcosystemDefaultStages', () => {
  it('derives node stages from package.json scripts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-eco-'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ scripts: { typecheck: 'tsc', test: 'jest' } }),
    );
    const defaults = deriveEcosystemDefaultStages('node', dir);
    const typecheck = defaults.stages.find((s) => s.id === 'typecheck');
    expect(typecheck?.tier).toBe('quick');
    expect(typecheck?.command).toContain('run typecheck');
    const tests = defaults.stages.find((s) => s.id === 'unit-tests');
    expect(tests?.tier).toBe('full');
    expect(tests?.command).toContain('npm} test');
  });

  it('falls back to build smoke when no typecheck script exists', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-eco-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'x' } }));
    const defaults = deriveEcosystemDefaultStages('node', dir);
    expect(defaults.stages.find((s) => s.id === 'typecheck')?.command).toContain('run build');
  });

  it('covers the non-node ecosystems as data', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-eco-'));
    expect(
      deriveEcosystemDefaultStages('python', dir).stages.find((s) => s.id === 'typecheck')?.command,
    ).toContain('compileall');
    expect(
      deriveEcosystemDefaultStages('go', dir).stages.find((s) => s.id === 'typecheck')?.command,
    ).toContain('go} build');
    expect(
      deriveEcosystemDefaultStages('rust', dir).stages.find((s) => s.id === 'typecheck')?.command,
    ).toContain('cargo} check');
  });
});

describe('ensureEcosystemVerificationStages', () => {
  function makeHarness(ecosystem: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-ensure-'));
    fs.mkdirSync(path.join(dir, '.har'));
    fs.writeFileSync(
      path.join(dir, '.har', 'harness.env'),
      `export HARNESS_PROJECT_NAME=fixture\nexport HARNESS_ECOSYSTEM=${ecosystem}\nexport HARNESS_AGENT_SLOT_MIN=1\nexport HARNESS_AGENT_SLOT_MAX=3\n`,
    );
    fs.mkdirSync(path.join(dir, '.har', 'stages'));
    fs.writeFileSync(path.join(dir, '.har', 'stages', 'readiness.sh'), '#!/usr/bin/env bash\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'jest' } }));
    return dir;
  }

  it('fills missing default stages without clobbering customized ones', () => {
    const dir = makeHarness('node');
    const custom = {
      version: '1',
      agentSlots: { min: 1, max: 3 },
      verificationStages: ['unit-tests', 'browser-e2e'],
      stages: [
        { id: 'unit-tests', kind: 'test', tier: 'full', command: 'my custom test runner' },
        { id: 'browser-e2e', kind: 'test', tier: 'full', script: 'stages/browser-e2e.sh' },
      ],
    };
    fs.writeFileSync(path.join(dir, '.har', 'stages.json'), JSON.stringify(custom, null, 2));

    expect(ensureEcosystemVerificationStages(dir)).toBe(true);
    const registry = JSON.parse(fs.readFileSync(path.join(dir, '.har', 'stages.json'), 'utf8'));

    // customized stage untouched
    expect(registry.stages.find((s: { id: string }) => s.id === 'unit-tests').command).toBe(
      'my custom test runner',
    );
    // missing defaults registered
    expect(registry.stages.some((s: { id: string }) => s.id === 'typecheck')).toBe(true);
    expect(registry.stages.some((s: { id: string }) => s.id === 'readiness')).toBe(true);
    // defaults inserted ahead of extras, existing relative order preserved
    const ids = registry.verificationStages as string[];
    expect(ids.indexOf('typecheck')).toBeLessThan(ids.indexOf('unit-tests'));
    expect(ids.indexOf('unit-tests')).toBeLessThan(ids.indexOf('browser-e2e'));
    // idempotent
    expect(ensureEcosystemVerificationStages(dir)).toBe(false);
  });
});

describe('verify-runner.mjs', () => {
  function runRunner(registry: unknown, args: string[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-runner-'));
    const harnessDir = path.join(dir, '.har');
    fs.mkdirSync(harnessDir);
    fs.writeFileSync(path.join(harnessDir, 'stages.json'), JSON.stringify(registry, null, 2));
    return spawnSync('node', [RUNNER, ...args], {
      encoding: 'utf8',
      env: { ...process.env, HAR_HARNESS_DIR: harnessDir, WORK_DIR: dir },
    });
  }

  it('records failing output containing quotes without dropping results', () => {
    const registry = {
      verificationStages: ['sq.quote-step', 'never-runs-quick'],
      stages: [
        {
          id: 'sq.quote-step',
          kind: 'test',
          tier: 'quick',
          command: `echo "it's a \\"quoted\\" \`backtick\` failure"; exit 1`,
        },
        { id: 'never-runs-quick', kind: 'test', tier: 'quick', command: 'true' },
      ],
    };
    const res = runRunner(registry, ['--agent', '2']);
    expect(res.status).toBe(1);
    const out = JSON.parse(res.stdout);
    expect(out.status).toBe('fail');
    expect(out.agent_id).toBe(2);
    expect(out.stages).toHaveLength(1); // quick mode stops at first failure
    expect(out.stages[0].name).toBe('sq.quote-step');
    expect(out.stages[0].pass).toBe(false);
    expect(out.stages[0].output).toContain(`it's a "quoted"  failure`);
  });

  it('full mode runs the whole plan in order and passes stage env without eval', () => {
    const registry = {
      verificationStages: ['second', 'first'],
      stages: [
        {
          id: 'second',
          kind: 'test',
          tier: 'full',
          command: 'echo "env=$STEP_ENV agent=$HAR_AGENT_ID"',
          env: { STEP_ENV: `tricky 'value' with spaces` },
        },
        { id: 'first', kind: 'test', tier: 'quick', command: 'true' },
      ],
    };
    const res = runRunner(registry, ['--agent', '1', '--full']);
    expect(res.status).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.status).toBe('pass');
    expect(out.stages.map((s: { name: string }) => s.name)).toEqual(['second', 'first']);
  });

  it('warns about phantom ids and keeps running', () => {
    const registry = {
      verificationStages: ['ghost', 'real'],
      stages: [{ id: 'real', kind: 'test', tier: 'quick', command: 'true' }],
    };
    const res = runRunner(registry, ['--agent', '1']);
    expect(res.status).toBe(0);
    expect(res.stderr).toContain('ghost');
    const out = JSON.parse(res.stdout);
    expect(out.stages.map((s: { name: string }) => s.name)).toEqual(['real']);
  });
});
