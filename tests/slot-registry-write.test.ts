import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readSlotRegistry,
  removeSlotRegistry,
  writeSlotRegistry,
} from '../src/core/slot-registry';
import { controlSyncLockPath, notifyControlSync } from '../src/core/control-notify';
import {
  loadAgentPorts,
  resolveAgentEnvFile,
  slotDirtySummary,
} from '../src/core/slot-status';

function makeRepo(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.har'), { recursive: true });
  return dir;
}

function gitInit(dir: string): void {
  execSync('git init -q', { cwd: dir });
  execSync(
    'git -c user.email=har@example.com -c user.name=har -c commit.gpgsign=false commit --allow-empty -qm init',
    { cwd: dir },
  );
}

describe('writeSlotRegistry', () => {
  const fullInput = {
    agentId: 3,
    projectName: 'demo',
    mode: 'worktree' as const,
    workDir: '/tmp/wt/demo',
    status: 'starting' as const,
    suffix: 'ab12',
    worktreePath: '/tmp/wt',
    branch: 'main-abcd-har-agent-3-ab12',
    baseBranch: 'main',
    baseCommit: 'deadbeef',
    lastError: 'boom',
    workUnitId: '234',
    attemptId: '123e4567-e89b-42d3-a456-426614174000',
    ports: { frontend: 3030, api: 8030, debug: 9230, db: 15432 },
    previewUrls: { frontend: 'http://localhost:3030', api: 'http://localhost:8030' },
  };

  it('is byte-compatible with the retired bash write_slot_registry', () => {
    const repo = makeRepo('har-reg-bytes-');
    const harDir = path.join(repo, '.har');

    // Golden bytes: the exact construction order and formatting of the retired
    // bash writer (agent-slot.sh write_slot_registry) — required keys first,
    // optionals in its fixed order, JSON.stringify(entry, null, 2) + newline.
    const createdAt = '2026-08-24T00:00:00.000Z';
    const goldenEntry: Record<string, unknown> = {
      version: 1,
      agentId: fullInput.agentId,
      projectName: fullInput.projectName,
      mode: fullInput.mode,
      workDir: fullInput.workDir,
      createdAt,
      status: fullInput.status,
      suffix: fullInput.suffix,
      worktreePath: fullInput.worktreePath,
      branch: fullInput.branch,
      baseBranch: fullInput.baseBranch,
      baseCommit: fullInput.baseCommit,
      lastError: fullInput.lastError,
      workUnitId: fullInput.workUnitId,
      attemptId: fullInput.attemptId,
      ports: fullInput.ports,
      previewUrls: fullInput.previewUrls,
    };
    const goldenBytes = JSON.stringify(goldenEntry, null, 2) + '\n';

    writeSlotRegistry(repo, { ...fullInput, createdAt, notifyControl: false });
    const tsBytes = fs.readFileSync(path.join(harDir, 'slots', 'agent-3.json'), 'utf8');

    expect(tsBytes).toBe(goldenBytes);
  });

  it('writes an entry readSlotRegistry accepts and preserves optional omissions', () => {
    const repo = makeRepo('har-reg-min-');
    writeSlotRegistry(repo, {
      agentId: 1,
      projectName: 'demo',
      mode: 'root',
      workDir: repo,
      notifyControl: false,
    });
    const entry = readSlotRegistry(repo, 1);
    expect(entry?.status).toBe('active');
    expect(entry?.mode).toBe('root');
    const raw = JSON.parse(
      fs.readFileSync(path.join(repo, '.har', 'slots', 'agent-1.json'), 'utf8'),
    );
    expect('suffix' in raw).toBe(false);
    expect('ports' in raw).toBe(false);
  });

  it('rejects entries the schema rejects', () => {
    const repo = makeRepo('har-reg-invalid-');
    expect(() =>
      writeSlotRegistry(repo, {
        agentId: 0,
        projectName: 'demo',
        mode: 'root',
        workDir: repo,
        notifyControl: false,
      }),
    ).toThrow(/Invalid slot registry entry/);
  });

  it('removeSlotRegistry deletes the entry and tolerates absence', () => {
    const repo = makeRepo('har-reg-remove-');
    writeSlotRegistry(repo, {
      agentId: 2,
      projectName: 'demo',
      mode: 'root',
      workDir: repo,
      notifyControl: false,
    });
    removeSlotRegistry(repo, 2, { notifyControl: false });
    expect(readSlotRegistry(repo, 2)).toBeUndefined();
    expect(() => removeSlotRegistry(repo, 2, { notifyControl: false })).not.toThrow();
  });
});

describe('notifyControlSync', () => {
  it('returns without waiting and coalesces via the shared lock', () => {
    const repo = makeRepo('har-notify-ts-');
    const binDir = path.join(repo, 'node_modules', '.bin');
    fs.mkdirSync(binDir, { recursive: true });
    const witness = path.join(repo, 'witness');
    fs.writeFileSync(
      path.join(binDir, 'har'),
      `#!/usr/bin/env bash\nsleep 5\necho ran >> "${witness}"\n`,
    );
    fs.chmodSync(path.join(binDir, 'har'), 0o755);

    const lock = controlSyncLockPath();
    fs.rmSync(`${lock}.pending`, { force: true });
    const preHeld = fs.existsSync(lock);

    const started = Date.now();
    notifyControlSync(repo);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3000);
    expect(fs.existsSync(witness)).toBe(false); // detached, deliberately not awaited
    if (!preHeld) {
      // We took the lock; a second nudge must return immediately, leaving a pending marker.
      notifyControlSync(repo);
      expect(fs.existsSync(`${lock}.pending`)).toBe(true);
      fs.rmSync(`${lock}.pending`, { force: true });
    }
  });
});

describe('slotDirtySummary', () => {
  it('reports unknown, clean, and dirty with a change count', () => {
    expect(slotDirtySummary(undefined)).toBe('unknown');
    expect(slotDirtySummary('/nonexistent/path')).toBe('unknown');

    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-dirty-'));
    gitInit(repo);
    expect(slotDirtySummary(repo)).toBe('clean');

    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    expect(slotDirtySummary(repo)).toBe('dirty (2 changed)');
  });
});

describe('resolveAgentEnvFile / loadAgentPorts', () => {
  it('resolves through the registry work dir first', () => {
    const repo = makeRepo('har-envfile-reg-');
    gitInit(repo);
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-envfile-wd-'));
    fs.writeFileSync(
      path.join(workDir, '.env.agent.4'),
      'FE_PORT=3040\nAPI_PORT=8040\nDEBUG_PORT=9240\nPGPORT=15433\n',
    );
    writeSlotRegistry(repo, {
      agentId: 4,
      projectName: 'demo',
      mode: 'worktree',
      workDir,
      notifyControl: false,
    });

    expect(resolveAgentEnvFile(repo, 4)).toBe(path.join(workDir, '.env.agent.4'));
    expect(loadAgentPorts(repo, 4)).toEqual({
      frontend: 3040,
      api: 8040,
      debug: 9240,
      db: 15433,
    });
  });

  it('falls back to the repo root env file and API_PORT←PORT alias', () => {
    const repo = makeRepo('har-envfile-root-');
    gitInit(repo);
    fs.writeFileSync(path.join(repo, '.env.agent.2'), 'export FE_PORT=3020\nPORT=8020\n');
    expect(resolveAgentEnvFile(repo, 2)).toBe(path.join(repo, '.env.agent.2'));
    expect(loadAgentPorts(repo, 2)).toEqual({
      frontend: 3020,
      api: 8020,
      debug: undefined,
      db: undefined,
    });
  });

  it('falls back to registry ports when no env file exists', () => {
    const repo = makeRepo('har-envfile-ports-');
    gitInit(repo);
    writeSlotRegistry(repo, {
      agentId: 5,
      projectName: 'demo',
      mode: 'worktree',
      workDir: path.join(repo, 'gone'),
      ports: { frontend: 3050, api: 8050, debug: 9250, db: 15432 },
      notifyControl: false,
    });
    expect(loadAgentPorts(repo, 5)).toEqual({
      frontend: 3050,
      api: 8050,
      debug: 9250,
      db: 15432,
    });
  });
});
