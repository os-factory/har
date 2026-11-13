import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import { syncSessionAttributionWithControl } from '../src/core/control-sync';
import {
  collectSessionAttribution,
  parseRemoteSessionBindings,
  type AttributionSlot,
} from '../src/core/session-attribution-sync';
import { recordSessionBinding } from '../src/core/session-bindings';
import { encodeClaudeProjectDir } from '../src/core/usage-harvest/claude';
import * as logging from '../src/utils/logging';

let tmp: string;
let repo: string;
let claudeRoot: string;
let codexRoot: string;

function writeJsonl(file: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function claudeTranscript(cwd: string, sessionId: string, requestIds: string[]): void {
  writeJsonl(
    path.join(claudeRoot, encodeClaudeProjectDir(cwd), `${sessionId}.jsonl`),
    requestIds.map((requestId, i) => ({
      type: 'assistant',
      sessionId,
      cwd,
      timestamp: `2026-11-12T10:0${i}:00.000Z`,
      requestId,
      message: {
        id: `msg-${requestId}`,
        model: 'claude-haiku-5-5',
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    })),
  );
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-attribution-sync-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(path.join(repo, '.har'), { recursive: true });
  claudeRoot = path.join(tmp, 'claude');
  codexRoot = path.join(tmp, 'codex');
  process.env.HAR_CLAUDE_PROJECTS_DIR = claudeRoot;
  process.env.HAR_CODEX_SESSIONS_DIR = codexRoot;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.HAR_CLAUDE_PROJECTS_DIR;
  delete process.env.HAR_CODEX_SESSIONS_DIR;
  jest.restoreAllMocks();
});

const workDir = () => path.join(tmp, 'worktrees', 'repo-har-agent-2');
const slots = (): AttributionSlot[] => [
  {
    agentId: 2,
    active: true,
    workDir: workDir(),
    worktreePath: workDir(),
    branch: 'main-abcd-har-agent-2-x1y2',
    attemptId: 'att-2',
    sessionCreatedAt: '2026-11-12T09:00:00.000Z',
  },
];

describe('collectSessionAttribution', () => {
  it('harvests bound sessions and sessions in a slot work dir, never unrelated ones', () => {
    recordSessionBinding(repo, {
      agentTool: 'claude_code',
      sessionId: 'launcher',
      kind: 'launch',
      slotId: 2,
      at: '2026-11-12T10:00:30.000Z',
    });
    claudeTranscript(repo, 'launcher', ['req-a', 'req-b']);
    claudeTranscript(workDir(), 'in-slot', ['req-c']);
    claudeTranscript(repo, 'observed-by-mc', ['req-d']);
    claudeTranscript(repo, 'unrelated', ['req-e']);

    const payload = collectSessionAttribution({
      sourcePaths: [repo],
      slots: slots(),
      remoteBindings: [
        {
          agentTool: 'claude_code',
          sessionId: 'observed-by-mc',
          kind: 'observed',
          slotId: 2,
          at: '2026-11-12T10:00:00.000Z',
        },
      ],
      harvest: true,
    });

    // Oldest first.
    expect(payload.bindings).toEqual([
      {
        agentTool: 'claude_code',
        sessionId: 'in-slot',
        kind: 'workspace',
        slotId: 2,
        occupancyKey: 'attempt::att-2',
        branch: 'main-abcd-har-agent-2-x1y2',
        at: '2026-11-12T10:00:00.000Z',
      },
      expect.objectContaining({ sessionId: 'launcher', kind: 'launch', slotId: 2 }),
    ]);
    // Pre-launch usage of the launcher is sent too: it is the session's
    // unassigned (main checkout) usage in Mission Control.
    expect(payload.observations.map((o) => [o.sessionId, o.observationKey]).sort()).toEqual([
      ['in-slot', 'req-c'],
      ['launcher', 'req-a'],
      ['launcher', 'req-b'],
      ['observed-by-mc', 'req-d'],
    ]);
  });

  it('sends bindings but reads no transcript when harvesting is off', () => {
    recordSessionBinding(repo, {
      agentTool: 'cursor',
      sessionId: 'conv',
      kind: 'launch',
      slotId: 2,
      at: '2026-11-12T10:00:30.000Z',
    });
    claudeTranscript(workDir(), 'in-slot', ['req-c']);
    const payload = collectSessionAttribution({
      sourcePaths: [repo],
      slots: slots(),
      harvest: false,
    });
    expect(payload.bindings.map((b) => b.sessionId)).toEqual(['conv']);
    expect(payload.observations).toEqual([]);
  });

  it('binds a Codex subagent thread as a subagent of its root thread', () => {
    writeJsonl(path.join(codexRoot, 'rollout-root.jsonl'), [
      {
        timestamp: '2026-11-12T10:00:00.000Z',
        type: 'session_meta',
        payload: { id: 'root', cwd: repo },
      },
    ]);
    writeJsonl(path.join(codexRoot, 'rollout-child.jsonl'), [
      {
        timestamp: '2026-11-12T10:01:00.000Z',
        type: 'session_meta',
        payload: {
          id: 'child',
          cwd: repo,
          source: { subagent: { thread_spawn: { parent_thread_id: 'root' } } },
        },
      },
      {
        timestamp: '2026-11-12T10:01:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 't1' },
      },
      {
        timestamp: '2026-11-12T10:01:02.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { total_tokens: 3 },
            last_token_usage: { input_tokens: 2, output_tokens: 1 },
          },
        },
      },
    ]);
    recordSessionBinding(repo, {
      agentTool: 'codex',
      sessionId: 'child',
      kind: 'launch',
      slotId: 2,
      at: '2026-11-12T10:01:01.500Z',
    });

    const payload = collectSessionAttribution({
      sourcePaths: [repo],
      slots: slots(),
      harvest: true,
    });

    expect(payload.bindings).toEqual([
      expect.objectContaining({
        agentTool: 'codex',
        sessionId: 'root',
        subagentId: 'child',
        kind: 'launch',
      }),
    ]);
    expect(payload.observations).toEqual([
      expect.objectContaining({ sessionId: 'root', subagentId: 'child', observationKey: 't1' }),
    ]);
  });
});

describe('parseRemoteSessionBindings', () => {
  it('keeps valid rows only', () => {
    expect(
      parseRemoteSessionBindings({
        bindings: [
          {
            agentTool: 'cursor',
            sessionId: 'c',
            kind: 'observed',
            slotId: 1,
            at: '2026-11-12T10:00:00.000Z',
          },
          { agentTool: 'nope' },
        ],
      }),
    ).toHaveLength(1);
    expect(parseRemoteSessionBindings(null)).toEqual([]);
  });
});

describe('syncSessionAttributionWithControl', () => {
  let server: http.Server;
  let apiUrl: string;
  let requests: Array<{ method: string; url: string; body: unknown }>;
  let supported: boolean;

  beforeEach(async () => {
    requests = [];
    supported = true;
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        requests.push({
          method: req.method ?? '',
          url: req.url ?? '',
          body: raw ? JSON.parse(raw) : null,
        });
        if (!supported) {
          res.writeHead(404).end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(req.method === 'GET' ? JSON.stringify({ bindings: [] }) : '{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('posts bindings and observations to Mission Control', async () => {
    recordSessionBinding(repo, {
      agentTool: 'claude_code',
      sessionId: 'launcher',
      kind: 'launch',
      slotId: 2,
      at: '2026-11-12T10:00:30.000Z',
    });
    claudeTranscript(repo, 'launcher', ['req-a']);

    const accepted = await syncSessionAttributionWithControl(
      apiUrl,
      'repo-1',
      [repo],
      slots(),
      true,
    );

    expect(accepted).toBe(true);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /api/repos/repo-1/session-bindings',
      'POST /api/repos/repo-1/session-bindings',
      'POST /api/repos/repo-1/usage-observations',
    ]);
    expect((requests[1].body as { bindings: unknown[] }).bindings).toHaveLength(1);
    expect(requests[2].body).toEqual({
      observations: [expect.objectContaining({ sessionId: 'launcher', observationKey: 'req-a' })],
    });
  });

  it('tolerates an older Mission Control: warns, never fails, reports observations unsupported', async () => {
    supported = false;
    const warn = jest.spyOn(logging, 'warn').mockImplementation(() => undefined);
    recordSessionBinding(repo, {
      agentTool: 'claude_code',
      sessionId: 'launcher',
      kind: 'launch',
      slotId: 2,
      at: '2026-11-12T10:00:30.000Z',
    });

    const accepted = await syncSessionAttributionWithControl(
      apiUrl,
      'repo-1',
      [repo],
      slots(),
      true,
    );

    expect(accepted).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('/session-bindings'));
    // The empty observations post still runs: it is how an older MC is detected.
    expect(requests.map((r) => `${r.method} ${r.url}`)).toContain(
      'POST /api/repos/repo-1/usage-observations',
    );
  });

  it('sends nothing when there is no binding and harvesting is off', async () => {
    const accepted = await syncSessionAttributionWithControl(
      apiUrl,
      'repo-1',
      [repo],
      slots(),
      false,
    );
    expect(accepted).toBe(true);
    expect(requests).toEqual([]);
  });
});
