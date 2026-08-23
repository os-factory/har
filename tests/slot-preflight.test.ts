import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  formatPreflightReport,
  inspectSlotReadiness,
  runLaunchPreflight,
} from '../src/core/slot-preflight';
import type { SlotReadiness } from '../src/harness/schema';
import { allocateAppPorts, isPortInUse } from '../src/core/slot-ports';

const tmpDirs: string[] = [];
const TEST_PORT_OFFSET = (process.pid % 400) * 10;
const TEST_FE_BASE = 40_000 + TEST_PORT_OFFSET;
const TEST_API_BASE = 50_000 + TEST_PORT_OFFSET;

function makeHarness(
  options: {
    pm2?: boolean;
    infraDb?: boolean;
    feBase?: number;
    apiBase?: number;
    useWorktree?: boolean;
  } = {},
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-preflight-'));
  tmpDirs.push(dir);
  const harDir = path.join(dir, '.har');
  fs.mkdirSync(harDir, { recursive: true });
  const feBase = options.feBase ?? TEST_FE_BASE;
  const apiBase = options.apiBase ?? TEST_API_BASE;
  const lines = [
    'export HARNESS_PROJECT_NAME=test-project',
    `export HARNESS_FE_BASE_PORT=${feBase}`,
    `export HARNESS_API_BASE_PORT=${apiBase}`,
    'export HARNESS_PORT_STEP=10',
    'export HARNESS_AGENT_SLOT_MIN=1',
    'export HARNESS_AGENT_SLOT_MAX=3',
  ];
  if (options.infraDb) {
    lines.push('export HARNESS_INFRA_SERVICES="db"');
    lines.push('export HARNESS_DB_PORT_DEFAULT=15432');
  }
  if (options.useWorktree !== undefined) {
    lines.push(`export HARNESS_USE_WORKTREE=${options.useWorktree}`);
  }
  fs.writeFileSync(path.join(harDir, 'harness.env'), lines.join('\n') + '\n');
  if (options.pm2) {
    fs.writeFileSync(
      path.join(harDir, 'ecosystem.agent.template.cjs'),
      'module.exports = { apps: [] };',
    );
  }
  return dir;
}

function writeOccupiedSlot(
  repo: string,
  agentId: number,
  dirty = false,
  status: 'active' | 'failed' | 'starting' = 'active',
): void {
  const worktree = path.join(repo, 'worktree');
  fs.mkdirSync(worktree, { recursive: true });
  fs.writeFileSync(path.join(worktree, '.env.agent.' + agentId), 'AGENT_ID=' + agentId + '\n');
  if (dirty) {
    fs.writeFileSync(path.join(worktree, 'dirty.txt'), 'x\n');
  }
  fs.mkdirSync(path.join(repo, '.har', 'slots'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.har', 'slots', `agent-${agentId}.json`),
    JSON.stringify({
      version: 1,
      agentId,
      projectName: 'test-project',
      mode: 'worktree',
      workDir: worktree,
      worktreePath: worktree,
      createdAt: new Date().toISOString(),
      status,
    }),
  );
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('inspectSlotReadiness', () => {
  it('returns ready for an empty cli harness slot', () => {
    const repo = makeHarness();
    const readiness = inspectSlotReadiness(repo, 1);
    expect(readiness.canLaunch).toBe(true);
    expect(readiness.verdict).toBe('ready');
    expect(readiness.blockers).toHaveLength(0);
  });

  it('always blocks when the slot is occupied', () => {
    const repo = makeHarness();
    writeOccupiedSlot(repo, 1);
    const readiness = inspectSlotReadiness(repo, 1);
    expect(readiness.canLaunch).toBe(false);
    expect(readiness.blockers.some((b) => b.code === 'slot_occupied')).toBe(true);
    expect(readiness.blockers.some((b) => b.remediation?.includes('har env teardown 1'))).toBe(
      true,
    );
  });

  it('allows launch when resume is requested for a resumable slot', () => {
    const repo = makeHarness();
    writeOccupiedSlot(repo, 1, false, 'failed');
    const readiness = inspectSlotReadiness(repo, 1, { resume: true });
    expect(readiness.canLaunch).toBe(true);
  });

  it('warns about untracked paths that will be missing from the session worktree', () => {
    const repo = makeHarness();
    const readiness = inspectSlotReadiness(repo, 1, {
      untrackedPaths: ['CLAUDE.md'],
    });
    expect(readiness.canLaunch).toBe(true);
    expect(readiness.warnings?.[0]).toContain('CLAUDE.md');
  });

  it('reports the warning even when the slot is blocked', () => {
    const repo = makeHarness();
    writeOccupiedSlot(repo, 1);
    const readiness = inspectSlotReadiness(repo, 1, {
      untrackedPaths: ['CLAUDE.md'],
    });
    expect(readiness.canLaunch).toBe(false);
    expect(formatPreflightReport(1, readiness)).toContain('WARN: 1 untracked path');
  });

  it('skips the check when slots run in the repo root', () => {
    const repo = makeHarness({ useWorktree: false });
    const readiness = inspectSlotReadiness(repo, 1, {
      untrackedPaths: ['CLAUDE.md'],
    });
    expect(readiness.warnings).toBeUndefined();
  });

  it('skips the check for a --no-worktree launch', () => {
    const repo = makeHarness();
    const readiness = inspectSlotReadiness(repo, 1, {
      worktree: false,
      untrackedPaths: ['CLAUDE.md'],
    });
    expect(readiness.warnings).toBeUndefined();
  });

  it('allocates app ports for PM2 harnesses', () => {
    const repo = makeHarness({ pm2: true });
    const readiness = inspectSlotReadiness(repo, 2, { pm2Processes: [] });
    expect(readiness.canLaunch).toBe(true);
    expect(readiness.ports?.frontend).toBe(TEST_FE_BASE + 20);
    expect(readiness.ports?.api).toBe(TEST_API_BASE + 20);
  });
});

describe('formatPreflightReport', () => {
  const ready = (extra: Partial<SlotReadiness>): SlotReadiness => ({
    canLaunch: true,
    verdict: 'ready',
    blockers: [],
    remediations: [],
    ports: { frontend: 3010 },
    allocatedPorts: true,
    ...extra,
  });

  it('drops the generic port note when a warning already explains the choice', () => {
    const report = formatPreflightReport(
      1,
      ready({ portChoiceExplained: true, warnings: ['har control up holds port 3000.'] }),
    );
    expect(report).not.toContain('alternate ports selected');
    expect(report).toContain('WARN: har control up holds port 3000.');
  });

  it('keeps the generic port note when only unrelated warnings are present', () => {
    const report = formatPreflightReport(
      1,
      ready({ warnings: ['1 untracked path will not appear in the session worktree: notes.txt.'] }),
    );
    expect(report).toContain('alternate ports selected');
  });
});

describe('allocateAppPorts', () => {
  it('returns defaults when ports are free', () => {
    // Use high bases so busy local stacks (e.g. docker on 3010) do not flake this unit test.
    const feBase = 47000;
    const apiBase = 48000;
    const repo = makeHarness({ pm2: true, feBase, apiBase });
    const ports = allocateAppPorts(repo, 1);
    expect('error' in ports).toBe(false);
    if (!('error' in ports)) {
      expect(ports.frontend).toBe(feBase + 10);
      expect(ports.api).toBe(apiBase + 10);
      expect(ports.allocated).toBe(false);
    }
  });
});

describe('isPortInUse', () => {
  it('returns false for a high ephemeral port unlikely to be bound', () => {
    expect(isPortInUse(59999)).toBe(false);
  });
});

describe('runLaunchPreflight', () => {
  it('returns ok with exit code 0 for an empty slot', () => {
    const repo = makeHarness();
    const result = runLaunchPreflight({ repoPath: repo, agentId: 1 });
    expect(result.status).toBe('ok');
    expect(result.exitCode).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('short-circuits an occupied slot with exit code 2 and bash-format errors', () => {
    const repo = makeHarness();
    writeOccupiedSlot(repo, 1);
    const result = runLaunchPreflight({ repoPath: repo, agentId: 1 });
    expect(result.status).toBe('occupied');
    expect(result.exitCode).toBe(2);
    expect(result.errors[0]).toBe('ERROR: slot 1 is occupied.');
    expect(result.errors[1]).toBe(
      '  Free it first: har env teardown 1 (or complete 1), then har env launch 1.',
    );
  });

  it('rejects resume of a non-resumable slot with exit code 2', () => {
    const repo = makeHarness();
    writeOccupiedSlot(repo, 1, false, 'active');
    const result = runLaunchPreflight({ repoPath: repo, agentId: 1, resume: true });
    expect(result.status).toBe('occupied');
    expect(result.exitCode).toBe(2);
    expect(result.errors[0]).toBe(
      'ERROR: slot 1 is not resumable (status=active; need failed or starting).',
    );
  });

  it('rejects resume of an empty slot with status=none', () => {
    const repo = makeHarness();
    const result = runLaunchPreflight({ repoPath: repo, agentId: 1, resume: true });
    expect(result.exitCode).toBe(2);
    expect(result.errors[0]).toBe(
      'ERROR: slot 1 is not resumable (status=none; need failed or starting).',
    );
  });

  it('resumes a failed slot with the bash resume banner', () => {
    const repo = makeHarness();
    writeOccupiedSlot(repo, 1, false, 'failed');
    const result = runLaunchPreflight({
      repoPath: repo,
      agentId: 1,
      resume: true,
      pm2Processes: [],
    });
    expect(result.status).toBe('ok');
    expect(result.exitCode).toBe(0);
    expect(result.notes[0]).toBe(
      '==> [agent-1] Resuming partial launch (worktree and deps preserved)...',
    );
  });

  it('blocks on foreign PM2 with exit code 1 and bash-format lines', () => {
    const repo = makeHarness({ pm2: true });
    const result = runLaunchPreflight({
      repoPath: repo,
      agentId: 1,
      pm2Processes: [{ name: 'har-other-project-agent-1-api', pm2_env: { pm_cwd: '/elsewhere' } }],
    });
    expect(result.status).toBe('blocked');
    expect(result.exitCode).toBe(1);
    expect(result.errors[0]).toBe('ERROR: foreign PM2 processes match agent 1:');
    expect(result.errors[1]).toBe('  har-other-project-agent-1-api  cwd=/elsewhere');
    expect(result.errors[2]).toBe('  Stop the other harness session or use a different slot.');
  });

  it('blocks on a docker port conflict with bash-format lines', () => {
    const repo = makeHarness({ pm2: true });
    const fePort = TEST_FE_BASE + 10;
    const result = runLaunchPreflight({
      repoPath: repo,
      agentId: 1,
      pm2Processes: [],
      dockerContainers: [{ name: 'other-app', ports: `0.0.0.0:${fePort}->3000/tcp` }],
    });
    expect(result.exitCode).toBe(1);
    expect(result.errors[0]).toBe(`ERROR: Docker container "other-app" binds port ${fePort}.`);
    expect(result.errors[1]).toBe('  Stop it with: docker stop other-app');
  });

  it('blocks on a control port conflict with bash-format lines', () => {
    const repo = makeHarness({ pm2: true });
    const fePort = TEST_FE_BASE + 10;
    const result = runLaunchPreflight({
      repoPath: repo,
      agentId: 1,
      pm2Processes: [],
      dockerContainers: [{ name: 'har-control-1', ports: `0.0.0.0:${fePort}->3847/tcp` }],
    });
    expect(result.exitCode).toBe(1);
    expect(result.errors[0]).toBe(
      `ERROR: har control up (container "har-control-1") occupies port ${fePort}.`,
    );
    expect(result.errors[1]).toBe('  Run: har control down — or use a different agent slot.');
  });

  it('honors the usesPm2 override instead of file presence', () => {
    const pm2Repo = makeHarness({ pm2: true });
    const skipped = runLaunchPreflight({ repoPath: pm2Repo, agentId: 1, usesPm2: false });
    expect(skipped.ports).toBeUndefined();

    const plainRepo = makeHarness();
    const forced = runLaunchPreflight({
      repoPath: plainRepo,
      agentId: 1,
      usesPm2: true,
      pm2Processes: [],
    });
    expect(forced.ports?.frontend).toBe(TEST_FE_BASE + 10);
    expect(forced.ports?.api).toBe(TEST_API_BASE + 10);
    expect(forced.ports?.debug).toBe(9210);
  });
});
