import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listUnregisterWorktreeCandidates } from '../src/core/control-unregister';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

describe('listUnregisterWorktreeCandidates', () => {
  let tempHome: string;
  let repo: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'har-unregister-'));
    process.env.HOME = tempHome;
    repo = fs.mkdtempSync(path.join(tempHome, 'repo-'));
    fs.cpSync(FIXTURE, repo, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns empty when no slots exist', () => {
    expect(listUnregisterWorktreeCandidates(repo)).toEqual([]);
  });

  it('lists worktrees from slot registry files', () => {
    const worktree = path.join(tempHome, 'wt-agent-1');
    fs.mkdirSync(worktree, { recursive: true });
    const slotsDir = path.join(repo, '.har', 'slots');
    fs.mkdirSync(slotsDir, { recursive: true });
    fs.writeFileSync(
      path.join(slotsDir, 'agent-1.json'),
      JSON.stringify({
        version: 1,
        agentId: 1,
        projectName: 'demo',
        mode: 'worktree',
        workDir: worktree,
        worktreePath: worktree,
        createdAt: new Date().toISOString(),
        status: 'active',
        branch: 'demo-branch',
      }),
    );

    const candidates = listUnregisterWorktreeCandidates(repo);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.agentId).toBe(1);
    expect(candidates[0]?.worktreePath).toBe(worktree);
    expect(candidates[0]?.exists).toBe(true);
  });
});
