import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { buildSync } from 'esbuild';
import {
  SessionContextLockError,
  openSessionSegment,
  readSessionContextFile,
  sessionContextFile,
  setSessionContextLockOptions,
} from '../src/core/session-context';
import { lockFileFor } from '../src/utils/file-lock';
import { SessionContextSchema, type SessionContext } from '../src/harness/schema';

/**
 * Session context files are read-modify-written by every HAR process on the
 * machine (launch in repo A while work-bind or complete runs in repo B). These
 * tests race real processes against one session file.
 */

const SESSION = { agentTool: 'claude_code', sessionId: 'shared-session' };
const WRITERS = 6;
const ROUNDS = 15;

let scratch: string;
let worker: string;

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'har-session-race-'));
  const entry = path.join(scratch, 'worker.ts');
  const sessionContext = path.join(__dirname, '..', 'src', 'core', 'session-context');
  fs.writeFileSync(
    entry,
    `import { closeSegmentsForOccupancy, openSessionSegment } from ${JSON.stringify(sessionContext)};
const [mode, index, rounds, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) { /* start together */ }
for (let r = 0; r < Number(rounds); r++) {
  if (mode === 'open') {
    openSessionSegment({
      agent: ${JSON.stringify(SESSION)},
      attributes: { 'factory.work_unit.id': 'w' + index + '-r' + r, 'factory.slot.id': index },
    });
  } else {
    // Another repo's teardown: closes whatever writer slot ${'${index}'} has open.
    for (let slot = 0; slot < ${WRITERS}; slot++) closeSegmentsForOccupancy({ occupancy: { slotId: String(slot) } });
  }
}
`,
  );
  worker = path.join(scratch, 'worker.js');
  buildSync({ entryPoints: [entry], bundle: true, platform: 'node', target: 'node20', outfile: worker, logLevel: 'silent' });
});

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

let sessionsDir: string;

beforeEach(() => {
  sessionsDir = fs.mkdtempSync(path.join(scratch, 'sessions-'));
});

afterEach(() => {
  setSessionContextLockOptions({});
});

function run(mode: 'open' | 'close', index: number, rounds: number, startAt: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [worker, mode, String(index), String(rounds), String(startAt)], {
      env: { ...process.env, HAR_SESSIONS_DIR: sessionsDir },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

function sharedFile(): string {
  const prev = process.env.HAR_SESSIONS_DIR;
  process.env.HAR_SESSIONS_DIR = sessionsDir;
  try {
    return sessionContextFile(SESSION)!;
  } finally {
    process.env.HAR_SESSIONS_DIR = prev;
  }
}

function expectInvariants(context: SessionContext): void {
  // The schema is the contract: ordered, non-overlapping, only the last open.
  expect(SessionContextSchema.safeParse(context).success).toBe(true);
  const { segments } = context;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (i < segments.length - 1) {
      expect(segment.to).not.toBeNull();
      expect(Date.parse(segment.to!)).toBeLessThanOrEqual(Date.parse(segments[i + 1].from));
    }
    if (segment.to !== null) expect(Date.parse(segment.to)).toBeGreaterThanOrEqual(Date.parse(segment.from));
  }
}

describe('session context writes under concurrency', () => {
  it(`${WRITERS} processes x ${ROUNDS} launches into one session lose no segment`, async () => {
    const startAt = Date.now() + 1_500;
    const results = await Promise.all(Array.from({ length: WRITERS }, (_, i) => run('open', i, ROUNDS, startAt)));
    for (const result of results) expect(result).toEqual({ code: 0, stderr: '' });

    const context = readSessionContextFile(sharedFile())!;
    expectInvariants(context);
    const ids = context.segments.map((s) => s.attributes['factory.work_unit.id']);
    expect(ids).toHaveLength(WRITERS * ROUNDS);
    expect(new Set(ids).size).toBe(WRITERS * ROUNDS);
    // Each writer's own segments stay in its round order.
    for (let w = 0; w < WRITERS; w++) {
      const mine = ids.filter((id) => id.startsWith(`w${w}-`));
      expect(mine).toEqual(Array.from({ length: ROUNDS }, (_, r) => `w${w}-r${r}`));
    }
    expect(context.segments.at(-1)!.to).toBeNull();
    expect(fs.readdirSync(path.dirname(sharedFile())).sort()).toEqual([path.basename(sharedFile())]);
  }, 60_000);

  it('launches racing teardowns from other processes keep the invariants and every segment', async () => {
    const startAt = Date.now() + 1_500;
    const results = await Promise.all([
      ...Array.from({ length: WRITERS - 2 }, (_, i) => run('open', i, ROUNDS, startAt)),
      run('close', 0, ROUNDS, startAt),
      run('close', 1, ROUNDS, startAt),
    ]);
    for (const result of results) expect(result).toEqual({ code: 0, stderr: '' });

    const context = readSessionContextFile(sharedFile())!;
    expectInvariants(context);
    const ids = context.segments.map((s) => s.attributes['factory.work_unit.id']);
    expect(new Set(ids).size).toBe((WRITERS - 2) * ROUNDS);
    expect(ids).toHaveLength((WRITERS - 2) * ROUNDS);
  }, 60_000);

  it('a lock that stays held fails the write loudly and writes nothing', () => {
    const prev = process.env.HAR_SESSIONS_DIR;
    process.env.HAR_SESSIONS_DIR = sessionsDir;
    try {
      openSessionSegment({ agent: SESSION, attributes: { 'factory.slot.id': '1' }, at: '2026-11-26T10:00:00.000Z' });
      const file = sharedFile();
      const before = fs.readFileSync(file, 'utf8');
      // A live HAR process (this one) holds the lock.
      fs.writeFileSync(lockFileFor(file), JSON.stringify({ pid: process.pid, token: 'other' }));
      setSessionContextLockOptions({ timeoutMs: 100 });
      expect(() => openSessionSegment({ agent: SESSION, attributes: { 'factory.slot.id': '2' } })).toThrow(
        SessionContextLockError,
      );
      expect(() => openSessionSegment({ agent: SESSION, attributes: { 'factory.slot.id': '2' } })).toThrow(
        /Session context not updated: Timed out .* Nothing was written/,
      );
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    } finally {
      process.env.HAR_SESSIONS_DIR = prev;
    }
  });
});
