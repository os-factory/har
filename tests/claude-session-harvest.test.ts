import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  fetchAttributedClaudeSessions,
  harvestAttributedClaudeUsage,
} from '../src/core/control-claude-sessions';
import {
  findClaudeTranscriptBySessionId,
  harvestClaudeUsageForSessions,
} from '../src/core/usage-harvest/claude-sessions';

const MAIN = '/repo/main';
const WORKTREE = '/worktrees/main-abcd-har-agent-2-xy12';
const SESSION = '7707de5f-74df-4df8-9376-e9fe20cd1f7b';

const prevProjectsDir = process.env.HAR_CLAUDE_PROJECTS_DIR;
const realFetch = global.fetch;
let projectsDir: string;

function writeTranscript(sessionId: string, cwd: string, project = cwd): void {
  const dir = path.join(projectsDir, project.replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const usage = {
    input_tokens: 10,
    output_tokens: 20,
    cache_read_input_tokens: 300,
    cache_creation_input_tokens: 40,
  };
  const assistant = (id: string, ts: string) => ({
    type: 'assistant',
    cwd,
    sessionId,
    timestamp: ts,
    message: { id, model: 'claude-opus-5-5', usage },
  });
  const lines = [
    { type: 'user', cwd, sessionId, timestamp: '2026-11-12T10:00:00.000Z', message: { content: 'go' } },
    assistant('msg_1', '2026-11-12T10:00:01.000Z'),
    // Claude Code repeats a split message's usage on every record — billed once.
    assistant('msg_1', '2026-11-12T10:00:02.000Z'),
    assistant('msg_2', '2026-11-12T10:05:00.000Z'),
  ];
  fs.writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
  );
}

function mockSpans(spans: unknown[] | Error): jest.Mock {
  const fetchMock = jest.fn(async () => {
    if (spans instanceof Error) throw spans;
    return { ok: true, status: 200, json: async () => ({ spans }) } as unknown as Response;
  });
  (global as unknown as { fetch: unknown }).fetch = fetchMock;
  return fetchMock;
}

function span(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: `span-${Math.random()}`,
    createdAt: '2026-11-12T10:00:00.000Z',
    sessionKey: SESSION,
    agentId: 2,
    agentTool: 'claude_code',
    attributes: { 'session.id': SESSION },
    ...overrides,
  };
}

beforeEach(() => {
  projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'har-claude-projects-'));
  process.env.HAR_CLAUDE_PROJECTS_DIR = projectsDir;
});

afterEach(() => {
  (global as unknown as { fetch: unknown }).fetch = realFetch;
  if (prevProjectsDir === undefined) delete process.env.HAR_CLAUDE_PROJECTS_DIR;
  else process.env.HAR_CLAUDE_PROJECTS_DIR = prevProjectsDir;
  fs.rmSync(projectsDir, { recursive: true, force: true });
});

describe('harvestClaudeUsageForSessions', () => {
  it('harvests a main-checkout session under the slot Mission Control attributed it to', () => {
    writeTranscript(SESSION, MAIN);

    const rows = harvestClaudeUsageForSessions(
      [{ sessionId: SESSION, sessionKey: SESSION, agentId: 2, workDir: WORKTREE, branch: 'b' }],
      [WORKTREE],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sessionKey: SESSION,
      agentId: 2,
      agentTool: 'claude_code',
      workDir: WORKTREE,
      branch: 'b',
      tokensInput: 20,
      tokensOutput: 40,
      tokensCacheRead: 600,
      tokensCacheCreation: 80,
      tokensTotal: 740,
      sources: ['harvest'],
      firstSeenAt: '2026-11-12T10:00:00.000Z',
      lastSeenAt: '2026-11-12T10:05:00.000Z',
    });
    expect(rows[0].modelBreakdown).toMatchObject({ 'claude-opus-5-5': { tokensTotal: 740 } });
  });

  it('leaves a session that ran inside a slot work dir to the per-slot harvest', () => {
    writeTranscript(SESSION, path.join(WORKTREE, 'apps'));
    const rows = harvestClaudeUsageForSessions(
      [{ sessionId: SESSION, sessionKey: SESSION, agentId: 2 }],
      [WORKTREE],
    );
    expect(rows).toEqual([]);
  });

  it('skips sessions without a transcript and posts each session once', () => {
    writeTranscript(SESSION, MAIN);
    const rows = harvestClaudeUsageForSessions(
      [
        { sessionId: SESSION, sessionKey: SESSION, agentId: 2 },
        { sessionId: SESSION, sessionKey: SESSION, agentId: 2 },
        { sessionId: 'aaaaaaaa-0000-4000-8000-000000000000', sessionKey: 'x', agentId: 1 },
      ],
      [],
    );
    expect(rows.map((row) => row.sessionKey)).toEqual([SESSION]);
  });

  it('never resolves a session id that is not a plain id', () => {
    writeTranscript(SESSION, MAIN);
    expect(findClaudeTranscriptBySessionId(`../${SESSION}`)).toBeNull();
    expect(findClaudeTranscriptBySessionId('')).toBeNull();
    expect(findClaudeTranscriptBySessionId(SESSION)).toMatch(new RegExp(`${SESSION}\\.jsonl$`));
  });
});

describe('fetchAttributedClaudeSessions', () => {
  it('reduces spans to one Claude session per session.id with its slot', async () => {
    const fetchMock = mockSpans([
      span({}),
      span({ agentId: 3 }), // later span of the same session — first one wins
      span({ agentTool: 'cursor', attributes: { 'session.id': 'cursor-session' } }),
      span({ attributes: {} }),
      span({
        sessionKey: 'other',
        agentId: 1,
        workUnitId: 'wu-1',
        attributes: { 'session.id': 'bbbbbbbb-0000-4000-8000-000000000000' },
      }),
    ]);

    const read = await fetchAttributedClaudeSessions('http://control.test', 'repo-1', [
      { agentId: 2, workDir: WORKTREE, branch: 'b', suffix: 'xy12' },
    ]);

    expect(String(fetchMock.mock.calls[0][0])).toContain('http://control.test/api/repos/repo-1/spans?');
    expect(read).toEqual({
      ok: true,
      truncated: false,
      sessions: [
        { sessionId: SESSION, sessionKey: SESSION, agentId: 2, workDir: WORKTREE, branch: 'b', suffix: 'xy12' },
        {
          sessionId: 'bbbbbbbb-0000-4000-8000-000000000000',
          sessionKey: 'other',
          agentId: 1,
          workUnitId: 'wu-1',
        },
      ],
    });
  });
});

describe('harvestAttributedClaudeUsage', () => {
  it('turns Mission Control spans into usage rows for the attributed slot', async () => {
    writeTranscript(SESSION, MAIN);
    mockSpans([span({})]);

    const result = await harvestAttributedClaudeUsage('http://control.test', 'repo-1', [
      { agentId: 2, workDir: WORKTREE },
    ]);

    expect(result.warning).toBeUndefined();
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]).toMatchObject({ sessionKey: SESSION, agentId: 2, workDir: WORKTREE, tokensTotal: 740 });
  });

  it('reports a warning instead of failing when Mission Control cannot be read', async () => {
    mockSpans(new Error('connect ECONNREFUSED'));
    const result = await harvestAttributedClaudeUsage('http://control.test', 'repo-1', []);
    expect(result.usage).toEqual([]);
    expect(result.warning).toContain('Claude session harvest skipped');
  });
});
