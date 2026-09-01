import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { scrubLocalHarnessDirs, scrubLocalHarnessForRepos } from './harness-scrub';

describe('scrubLocalHarnessDirs', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    temps.length = 0;
  });

  it('reports invisible repository paths without throwing', () => {
    const results = scrubLocalHarnessDirs('/tmp/definitely-missing-har-repo');
    expect(results).toHaveLength(5);
    expect(results.every((row) => row.deleted === false)).toBe(true);
    expect(results[0]?.error).toMatch(/not visible|har control reset/i);
  });

  it('removes runs validations state and slots under .har', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-scrub-repo-'));
    temps.push(repo);
    for (const directory of ['runs', 'validations', 'commit-bindings', 'state', 'slots']) {
      const target = path.join(repo, '.har', directory);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'keep-me-not.txt'), 'x');
    }
    // Leave artifacts alone.
    fs.mkdirSync(path.join(repo, '.har', 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.har', 'artifacts', 'note.txt'), 'keep');

    const results = scrubLocalHarnessDirs(repo);
    expect(results.every((row) => row.deleted)).toBe(true);
    expect(fs.existsSync(path.join(repo, '.har', 'runs'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.har', 'validations'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.har', 'state'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.har', 'slots'))).toBe(false);
    expect(fs.existsSync(path.join(repo, '.har', 'artifacts', 'note.txt'))).toBe(true);
  });

  it('treats already-missing dirs as deleted', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-scrub-empty-'));
    temps.push(repo);
    fs.mkdirSync(path.join(repo, '.har'), { recursive: true });
    const results = scrubLocalHarnessDirs(repo);
    expect(results.every((row) => row.deleted)).toBe(true);
  });

  it('dedupes repository paths', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-scrub-dedupe-'));
    temps.push(repo);
    fs.mkdirSync(path.join(repo, '.har', 'runs'), { recursive: true });
    const results = scrubLocalHarnessForRepos([repo, path.resolve(repo)]);
    expect(results).toHaveLength(5);
  });
});
