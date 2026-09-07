import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Larger than /proc/sys/fs/pipe-max-size on typical Linux (1 MiB) and the 64 KiB macOS buffer. */
const BODY_BYTES = 2 * 1024 * 1024;

const repoRoot = path.resolve(__dirname, '..');

function runCurlPipeline(reader: string): number {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-readiness-'));
  const file = path.join(dir, 'page.html');
  fs.writeFileSync(file, `<html>${'x'.repeat(BODY_BYTES)}`);
  const script = `
    set -euo pipefail
    curl -sf "file://${file}" | ${reader}
  `;
  try {
    return spawnSync('bash', ['-c', script], { encoding: 'utf8' }).status ?? 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('readiness curl | grep under pipefail', () => {
  it('fails when the reader closes the pipe before curl finishes (exit 23)', () => {
    // head -c always closes early. grep -q does the same on BSD/macOS and
    // older GNU grep; GNU grep 3.12 drains stdin on -q, so it is not portable
    // as the writer-side repro.
    expect(runCurlPipeline('head -c 16 >/dev/null')).toBe(23);
  });

  it('passes when grep -c reads the body to EOF', () => {
    expect(runCurlPipeline('grep -ci "<html" >/dev/null')).toBe(0);
  });
});

const CURL_PIPE_GREP_QUIET = /curl[^\n]*\|\s*grep\s+-[A-Za-z]*q/;

function collectFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, acc);
    else if (entry.name === 'harness.env' || entry.name.endsWith('.md')) acc.push(full);
  }
  return acc;
}

describe('readiness examples avoid curl | grep -q', () => {
  it('does not recommend a quiet-grep curl pipe in harness.env or docs', () => {
    const files = [
      ...collectFiles(path.join(repoRoot, 'src', 'templates')),
      ...collectFiles(path.join(repoRoot, 'docs', 'src', 'content')),
      path.join(repoRoot, 'docs', '.har', 'harness.env'),
      path.join(repoRoot, 'docs', '.har', 'README.md'),
      path.join(repoRoot, '.har', 'harness.env'),
      path.join(repoRoot, 'control', '.har', 'harness.env'),
    ].filter((file) => fs.existsSync(file));

    const hits: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      if (CURL_PIPE_GREP_QUIET.test(text)) hits.push(path.relative(repoRoot, file));
    }
    expect(hits).toEqual([]);
  });
});
