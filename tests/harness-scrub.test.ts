import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scrubLocalHarnessDirs } from '../src/core/harness-scrub';

describe('CLI harness scrub', () => {
  const temps: string[] = [];

  afterEach(() => {
    for (const dir of temps) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    temps.length = 0;
  });

  it('removes the four sync-polluting .har directories', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'har-cli-scrub-'));
    temps.push(repo);
    for (const directory of ['runs', 'validations', 'state', 'slots']) {
      fs.mkdirSync(path.join(repo, '.har', directory), { recursive: true });
    }

    const results = scrubLocalHarnessDirs(repo);
    expect(results).toHaveLength(4);
    expect(results.every((row) => row.deleted)).toBe(true);
    expect(fs.existsSync(path.join(repo, '.har', 'runs'))).toBe(false);
  });
});
