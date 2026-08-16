import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  classifySlotCandidate,
  discoverCleanupCandidates,
  formatCleanupPlan,
  parseCleanupKeepPins,
  selectAutoApprovedCandidates,
} from '../src/core/cleanup-service';

const FIXTURE = path.join(__dirname, 'fixtures/minimal-harness');

describe('cleanup-service', () => {
  let tempHome: string;
  let repo: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'har-cleanup-'));
    process.env.HOME = tempHome;
    process.env.HAR_WORKTREES_ROOT = path.join(tempHome, 'worktrees');
    process.env.HAR_CONTROL_REGISTRY_PATH = path.join(tempHome, '.har', 'repos.json');
    repo = fs.mkdtempSync(path.join(tempHome, 'repo-'));
    fs.cpSync(FIXTURE, repo, { recursive: true });
    fs.mkdirSync(path.join(tempHome, '.har'), { recursive: true });
    fs.writeFileSync(
      path.join(tempHome, '.har', 'repos.json'),
      JSON.stringify({ repos: [repo] }) + '\n',
    );
  });

  afterEach(() => {
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it('returns empty plan when no slots are active', async () => {
    const plan = await discoverCleanupCandidates({ repoPaths: [repo], orphans: false });
    expect(plan.candidates).toEqual([]);
  });

  it('classifies stale clean sessions as teardown', () => {
    const createdAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const candidate = classifySlotCandidate(repo, 'demo', {
      agentId: 1,
      active: true,
      worktreePath: '/tmp/wt',
      branch: 'demo-branch',
      sessionCreatedAt: createdAt,
      dirty: false,
      harnessUsage: 'none',
    });
    expect(candidate?.recommendation).toBe('teardown');
  });

  it('pins keep targets from repo:agent syntax', () => {
    const candidate = classifySlotCandidate(
      repo,
      'demo',
      {
        agentId: 4,
        active: true,
        worktreePath: '/tmp/wt',
        sessionCreatedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
        dirty: false,
        harnessUsage: 'none',
      },
      { keep: parseCleanupKeepPins([`${repo}:4`]) },
    );
    expect(candidate?.recommendation).toBe('keep');
  });

  it('discovers orphan worktrees under ~/worktrees', async () => {
    const worktreesRoot = path.join(tempHome, 'worktrees');
    fs.mkdirSync(worktreesRoot, { recursive: true });
    const orphan = path.join(worktreesRoot, 'main-deadbeef-har-agent-9-abcd');
    fs.mkdirSync(orphan, { recursive: true });

    const plan = await discoverCleanupCandidates({ repoPaths: [repo], orphans: true });
    expect(plan.candidates.some((c) => c.kind === 'orphan_worktree' && c.worktreePath === orphan)).toBe(
      true,
    );
  });

  it('formats a readable plan table', async () => {
    const worktree = path.join(tempHome, 'wt-agent-1');
    fs.mkdirSync(worktree, { recursive: true });
    fs.mkdirSync(path.join(repo, '.har', 'slots'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, '.har', 'slots', 'agent-1.json'),
      JSON.stringify({
        version: 1,
        agentId: 1,
        projectName: 'demo',
        mode: 'worktree',
        workDir: worktree,
        worktreePath: worktree,
        createdAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        status: 'active',
        branch: 'demo-branch',
      }),
    );
    fs.writeFileSync(path.join(worktree, '.env.agent.1'), 'HARNESS_AGENT_ID=1\n');

    const plan = await discoverCleanupCandidates({ repoPaths: [repo] });
    const text = formatCleanupPlan(plan);
    expect(text).toContain('teardown');
    expect(selectAutoApprovedCandidates(plan).length).toBeGreaterThanOrEqual(1);
  });
});
