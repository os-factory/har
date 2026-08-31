import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { attachCommit, recordValidation } from '../src/core/validations';
import { listCommitBindings } from '../src/core/commit-bindings';

function sh(cwd: string, command: string): string {
  return execSync(command, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function initRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-bind-'));
  sh(dir, 'git init -q -b main');
  sh(dir, 'git config user.email har@test.local');
  sh(dir, 'git config user.name har');
  fs.mkdirSync(path.join(dir, '.har'));
  fs.writeFileSync(path.join(dir, '.har', '.gitignore'), 'runs/\nvalidations/\n');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  sh(dir, 'git add -A');
  sh(dir, 'git commit -q -m init');
  return dir;
}

describe('commit bindings', () => {
  it('records a second commit that reuses the same content snapshot', () => {
    const dir = initRepo();
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    const record = recordValidation({
      checkoutDir: dir,
      harnessRoot: dir,
      status: 'pass',
      full: true,
    });

    sh(dir, 'git add -A');
    sh(dir, 'git commit -q -m first');
    const first = sh(dir, 'git rev-parse HEAD');
    const tree = sh(dir, 'git rev-parse HEAD^{tree}');
    expect(tree).toBe(record.treeHash);

    attachCommit(dir, tree, first, {
      parents: [sh(dir, 'git rev-parse HEAD^')],
      refs: ['main'],
      message: 'first',
    });

    const reused = sh(dir, `git commit-tree ${tree} -p ${first} -m reused`);
    attachCommit(dir, tree, reused, {
      parents: [first],
      refs: ['main'],
      message: 'reused',
    });

    const bindings = listCommitBindings(dir);
    expect(bindings).toHaveLength(2);
    expect(new Set(bindings.map((row) => row.commitSha))).toEqual(new Set([first, reused]));
    expect(new Set(bindings.map((row) => row.treeHash))).toEqual(new Set([tree]));
    expect(fs.readFileSync(path.join(dir, '.har', '.gitignore'), 'utf8')).toContain('commit-bindings/');
  });
});
