import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

/**
 * Stage logs written by the verify runner (ADR 0005 section 4): combined
 * stdout+stderr, last 1 MiB kept with the header line counted in the cap.
 */

const RUNNER = path.join(
  __dirname,
  '..',
  'src',
  'templates',
  'runtime',
  'verify-runner.mjs',
);

const LIMIT = 1024 * 1024;
const HEADER = /^\[har\] (\d+) bytes dropped, last (\d+) bytes kept\n/;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-stage-logs-'));
  fs.mkdirSync(path.join(dir, '.har'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function node(script: string): string {
  return `node -e ${JSON.stringify(script).replace(/\$/g, '\\$')}`;
}

function runStages(stages: Array<{ id: string; command: string }>, opts: { logDir?: string | null } = {}) {
  fs.writeFileSync(
    path.join(dir, '.har', 'stages.json'),
    JSON.stringify({
      verificationStages: stages.map((stage) => stage.id),
      stages: stages.map((stage) => ({ ...stage, kind: 'test', tier: 'quick' })),
    }),
  );
  const logDir = opts.logDir === null ? undefined : (opts.logDir ?? path.join(dir, '.har', 'artifacts', '.staging', 'run'));
  const env: NodeJS.ProcessEnv = { ...process.env, HAR_HARNESS_DIR: path.join(dir, '.har'), WORK_DIR: dir };
  delete env.HAR_STAGE_LOG_DIR;
  if (logDir) env.HAR_STAGE_LOG_DIR = logDir;
  const res = spawnSync('node', [RUNNER, '--agent', '1', '--full'], { encoding: 'utf8', env });
  return { res, logDir };
}

function readLog(logDir: string, id: string): Buffer {
  return fs.readFileSync(path.join(logDir, `${id}.log`));
}

describe('verify-runner stage logs', () => {
  it('keeps output of exactly 1 MiB as is, with no header', () => {
    const { res, logDir } = runStages([
      { id: 'exact', command: node(`process.stdout.write('x'.repeat(${LIMIT}))`) },
    ]);
    expect(res.status).toBe(0);
    const log = readLog(logDir!, 'exact');
    expect(log.length).toBe(LIMIT);
    expect(HEADER.test(log.subarray(0, 80).toString('utf8'))).toBe(false);
    const index = JSON.parse(fs.readFileSync(path.join(logDir!, 'index.json'), 'utf8'));
    expect(index.stages).toEqual([{ id: 'exact', log: 'exact.log', totalBytes: LIMIT, artifacts: [] }]);
  });

  it('one byte over: header + tail, the whole file at most 1 MiB', () => {
    // 'a' then LIMIT bytes of digits: the kept tail must be the last K bytes.
    const { logDir } = runStages([
      {
        id: 'over',
        command: node(
          `let s='a';for(let i=0;i<${LIMIT};i++)s+=String(i%10);process.stdout.write(s)`,
        ),
      },
    ]);
    const log = readLog(logDir!, 'over');
    expect(log.length).toBeLessThanOrEqual(LIMIT);
    const text = log.toString('utf8');
    const match = HEADER.exec(text)!;
    expect(match).not.toBeNull();
    const dropped = Number(match[1]);
    const kept = Number(match[2]);
    expect(dropped + kept).toBe(LIMIT + 1);
    expect(match[0].length + kept).toBe(log.length);
    // Exactly at the cap: the header is paid for with tail bytes.
    expect(log.length).toBe(LIMIT);
    let expected = '';
    for (let i = 0; i < LIMIT; i++) expected += String(i % 10);
    expect(text.slice(match[0].length)).toBe(expected.slice(expected.length - kept));
  });

  it('multi-chunk output on both streams keeps only the tail', () => {
    const { logDir } = runStages([
      {
        id: 'chunks',
        // Each write waits for the previous one, so neither pipe runs ahead of the
        // other by more than its buffer, even on a loaded machine.
        command: node(
          `const line='y'.repeat(1023)+'\\n';let i=0;` +
            `const next=()=>{if(i===3*1024){process.stdout.write('LAST\\n');return}` +
            `(i%2?process.stderr:process.stdout).write(line,next);i++};next()`,
        ),
      },
    ]);
    const log = readLog(logDir!, 'chunks');
    expect(log.length).toBeLessThanOrEqual(LIMIT);
    const text = log.toString('utf8');
    const match = HEADER.exec(text)!;
    expect(Number(match[1]) + Number(match[2])).toBe(3 * 1024 * 1024 + 5);
    // Two pipes give no cross-stream ordering guarantee at the very end; the
    // marker written last is within the final pipe buffers.
    expect(text.slice(-256 * 1024)).toContain('LAST\n');
  });

  it('interleaves stdout and stderr in arrival order', () => {
    const { logDir } = runStages([
      { id: 'mixed', command: 'echo one; sleep 0.1; echo two >&2; sleep 0.1; echo three' },
    ]);
    expect(readLog(logDir!, 'mixed').toString('utf8')).toBe('one\ntwo\nthree\n');
  });

  it.each([0, 1])('never starts the kept tail inside a UTF-8 sequence (offset %i)', (offset) => {
    const { logDir } = runStages([
      { id: 'utf8', command: node(`process.stdout.write('a'.repeat(${offset})+'é'.repeat(600000))`) },
    ]);
    const log = readLog(logDir!, 'utf8');
    expect(log.length).toBeLessThanOrEqual(LIMIT);
    const text = log.toString('utf8');
    const match = HEADER.exec(text)!;
    const tail = text.slice(match[0].length);
    expect(tail).not.toContain('�');
    expect(/^é+$/.test(tail)).toBe(true);
    expect(Number(match[1]) + Number(match[2])).toBe(offset + 1200000);
    expect(Buffer.byteLength(tail)).toBe(Number(match[2]));
  });

  it('attributes files a stage writes under .har/artifacts/ to that stage', () => {
    const runDir = path.join(dir, '.har', 'artifacts', '0b3f5a8e-1c2d-4e5f-8a9b-0c1d2e3f4a5b');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.har', 'artifacts', 'kept.txt'), 'before');
    const { logDir } = runStages([
      {
        id: 'e2e',
        command:
          'mkdir -p .har/artifacts/e2e/shots && echo png > .har/artifacts/e2e/shots/home.png && ' +
          `echo other-run > ${JSON.stringify(path.join(runDir, 'x.log'))}`,
      },
      { id: 'report', command: 'echo "{}" > .har/artifacts/report.json; echo changed >> .har/artifacts/kept.txt' },
    ]);
    const index = JSON.parse(fs.readFileSync(path.join(logDir!, 'index.json'), 'utf8'));
    expect(index.stages.map((s: { id: string; artifacts: string[] }) => [s.id, s.artifacts])).toEqual([
      ['e2e', ['e2e/shots/home.png']],
      ['report', ['kept.txt', 'report.json']],
    ]);
  });

  it('does not pass HAR_STAGE_LOG_DIR to stages', () => {
    const { logDir } = runStages([{ id: 'env', command: 'echo "${HAR_STAGE_LOG_DIR:-unset}"' }]);
    expect(readLog(logDir!, 'env').toString('utf8')).toBe('unset\n');
  });

  it('writes no logs without HAR_STAGE_LOG_DIR', () => {
    const { res } = runStages([{ id: 'quiet', command: 'echo hi' }], { logDir: null });
    expect(res.status).toBe(0);
    expect(fs.existsSync(path.join(dir, '.har', 'artifacts'))).toBe(false);
  });
});
