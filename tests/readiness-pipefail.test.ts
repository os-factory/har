import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Larger than /proc/sys/fs/pipe-max-size on typical Linux (1 MiB) and the 64 KiB macOS buffer. */
const BODY_BYTES = 2 * 1024 * 1024;

const repoRoot = path.resolve(__dirname, '..');
const readinessScript = path.join(
  repoRoot,
  'src',
  'templates',
  'runtime-bundles',
  'shared-kernel',
  'stages',
  'readiness.sh',
);

function writeLargePage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-readiness-'));
  const file = path.join(dir, 'page.html');
  fs.writeFileSync(file, `<html>${'x'.repeat(BODY_BYTES)}`);
  return file;
}

function runReadiness(cmd: string): number {
  return (
    spawnSync('bash', [readinessScript, '1'], {
      encoding: 'utf8',
      env: { ...process.env, HARNESS_READINESS_CMD: cmd },
    }).status ?? 1
  );
}

describe('readiness.sh HARNESS_READINESS_CMD', () => {
  let page: string;

  beforeAll(() => {
    page = writeLargePage();
  });

  afterAll(() => {
    fs.rmSync(path.dirname(page), { recursive: true, force: true });
  });

  it('skips when the command is unset', () => {
    const result = spawnSync('bash', [readinessScript, '1'], {
      encoding: 'utf8',
      env: { ...process.env, HARNESS_READINESS_CMD: '' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/skipping readiness smoke/);
  });

  it('treats a curl | early-close match as success (no pipefail on the project command)', () => {
    // head -c always closes early — the same SIGPIPE curl sees from grep -q on
    // BSD/macOS and older GNU grep (GNU 3.12 drains stdin on -q).
    expect(runReadiness(`curl -sf "file://${page}" | head -c 16 >/dev/null`)).toBe(0);
  });

  it('still fails when the last command does not match', () => {
    expect(runReadiness(`curl -sf "file://${page}" | grep -c "NO-SUCH-MARKER" >/dev/null`)).not.toBe(0);
  });

  it('still fails when the command is a failing curl with no pipe', () => {
    expect(runReadiness('curl -sf "file:///no/such/readiness-page.html"')).not.toBe(0);
  });
});
