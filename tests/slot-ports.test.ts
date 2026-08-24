import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import { computePreviewUrls } from '../src/core/local-executor';
import {
  defaultAppPort,
  loadInfraState,
  pickFreePort,
  portStep,
  slotPortLaneEnd,
} from '../src/core/slot-ports';

const tmpDirs: string[] = [];

function makeHarness(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-ports-'));
  tmpDirs.push(dir);
  const harDir = path.join(dir, '.har');
  fs.mkdirSync(harDir, { recursive: true });
  fs.writeFileSync(
    path.join(harDir, 'harness.env'),
    [
      'export HARNESS_PROJECT_NAME=test-project',
      'export HARNESS_FE_BASE_PORT=3000',
      'export HARNESS_API_BASE_PORT=8000',
      'export HARNESS_PORT_STEP=10',
      'export HARNESS_HEALTH_CHECK_PATH=/health',
      'export HARNESS_AGENT_SLOT_MIN=1',
      'export HARNESS_AGENT_SLOT_MAX=3',
    ].join('\n') + '\n',
  );
  return dir;
}

function writeRegistryEntry(
  repo: string,
  agentId: number,
  overrides: Record<string, unknown> = {},
): void {
  const slotsDir = path.join(repo, '.har', 'slots');
  fs.mkdirSync(slotsDir, { recursive: true });
  fs.writeFileSync(
    path.join(slotsDir, `agent-${agentId}.json`),
    JSON.stringify({
      version: 1,
      agentId,
      projectName: 'test-project',
      mode: 'worktree',
      workDir: '/tmp/work',
      createdAt: new Date().toISOString(),
      status: 'active',
      ...overrides,
    }),
  );
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('computePreviewUrls', () => {
  it('prefers persisted previewUrls from the slot registry', () => {
    const repo = makeHarness();
    writeRegistryEntry(repo, 1, {
      previewUrls: {
        frontend: 'http://localhost:3999',
        api: 'http://localhost:8999',
      },
    });

    expect(computePreviewUrls(repo, 1)).toEqual({
      frontend: 'http://localhost:3999',
      api: 'http://localhost:8999',
    });
  });

  it('builds preview URLs from persisted ports when previewUrls absent', () => {
    const repo = makeHarness();
    writeRegistryEntry(repo, 2, {
      ports: { frontend: 3055, api: 8055, debug: 9220 },
    });

    expect(computePreviewUrls(repo, 2)).toEqual({
      frontend: 'http://localhost:3055',
      api: 'http://localhost:8055',
      health: 'http://localhost:8055/health',
    });
  });

  it('falls back to formula when no registry entry exists', () => {
    const repo = makeHarness();
    expect(computePreviewUrls(repo, 3)).toEqual({
      frontend: 'http://localhost:3030',
      api: 'http://localhost:8030',
      health: 'http://localhost:8030/health',
    });
  });
});

// PM2 slot naming formulas are TS-only since #234 (pm2SlotPrefix / pm2DeleteRegex
// in src/runtime/process.ts, covered by tests/runtime-process.test.ts).

describe('port formulas', () => {
  it('computes default app ports and lane ends (step 10)', () => {
    expect(defaultAppPort(3000, 2, 10)).toBe(3020);
    expect(slotPortLaneEnd(3020, 10)).toBe(3029);
    expect(portStep({})).toBe(10);
    expect(portStep({ HARNESS_PORT_STEP: '20' })).toBe(20);
  });
});

describe('pickFreePort', () => {
  it('skips an occupied port and returns the next free one in the lane', async () => {
    const start = 58730;
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(start, '127.0.0.1', () => resolve());
    });
    try {
      expect(pickFreePort(start, start + 9)).toBe(start + 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('returns undefined when the whole range is busy', async () => {
    const start = 58750;
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(start, '127.0.0.1', () => resolve());
    });
    try {
      expect(pickFreePort(start, start)).toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('loadInfraState', () => {
  it('reads persisted host ports from .har/state/infra.env', () => {
    const repo = makeHarness();
    const stateDir = path.join(repo, '.har', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, 'infra.env'),
      '# Persisted by setup-infra.sh\nexport AGENT_DB_PORT=15433\nexport AGENT_MINIO_PORT=19001\n',
    );
    const state = loadInfraState(repo);
    expect(state.AGENT_DB_PORT).toBe('15433');
    expect(state.AGENT_MINIO_PORT).toBe('19001');
  });

  it('returns an empty object when no state file exists', () => {
    const repo = makeHarness();
    expect(loadInfraState(repo)).toEqual({});
  });

  it('falls back to the main checkout via git-common-dir when launching from a worktree', () => {
    const main = makeHarness();
    execSync('git init -q -b main && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', {
      cwd: main,
      stdio: 'ignore',
      shell: '/bin/bash',
    });
    const stateDir = path.join(main, '.har', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'infra.env'), 'export AGENT_DB_PORT=15440\n');
    const worktree = path.join(main, '..', path.basename(main) + '-wt');
    tmpDirs.push(worktree);
    execSync(`git worktree add -q ${JSON.stringify(worktree)} -b wt-branch`, {
      cwd: main,
      stdio: 'ignore',
    });
    const state = loadInfraState(worktree, worktree);
    expect(state.AGENT_DB_PORT).toBe('15440');
  });
});
