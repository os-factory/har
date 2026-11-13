import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { UsageObservationSchema } from '../src/harness/schema';
import {
  claudeObservationsFromRecords,
  findClaudeSessionsInWorkDirs,
  harvestClaudeSessionObservations,
} from '../src/core/usage-harvest/claude-observations';
import {
  codexObservationsFromRecords,
  codexSessionRef,
  findCodexSessionsInWorkDirs,
  harvestCodexSessionObservations,
  indexCodexRollouts,
} from '../src/core/usage-harvest/codex-observations';
import { encodeClaudeProjectDir } from '../src/core/usage-harvest/claude';

// Record shapes follow Claude Code 2.1 transcripts and Codex 0.163 rollouts
// (field names verified in ADR 0003 "Verified"); content is synthetic.

let tmp: string;
let claudeRoot: string;
let codexRoot: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'har-observations-'));
  claudeRoot = path.join(tmp, 'claude-projects');
  codexRoot = path.join(tmp, 'codex-sessions');
  process.env.HAR_CLAUDE_PROJECTS_DIR = claudeRoot;
  process.env.HAR_CODEX_SESSIONS_DIR = codexRoot;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.HAR_CLAUDE_PROJECTS_DIR;
  delete process.env.HAR_CODEX_SESSIONS_DIR;
});

function writeJsonl(file: string, records: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function assistant(
  messageId: string,
  requestId: string,
  timestamp: string,
  usage: Record<string, number>,
  extra: Record<string, unknown> = {},
) {
  return {
    type: 'assistant',
    sessionId: 'sess-1',
    cwd: '/repo',
    timestamp,
    requestId,
    isSidechain: false,
    message: { id: messageId, model: 'claude-haiku-5-5', role: 'assistant', usage, content: [] },
    ...extra,
  };
}

describe('Claude observations', () => {
  it('emits one request observation per message, keyed by request id, last split record wins', () => {
    const records = [
      {
        type: 'user',
        sessionId: 'sess-1',
        cwd: '/repo',
        timestamp: '2026-11-12T10:00:00.000Z',
        message: { role: 'user', content: 'hi' },
      },
      assistant('msg_1', 'req_1', '2026-11-12T10:00:01.000Z', {
        input_tokens: 2,
        output_tokens: 5,
      }),
      assistant('msg_1', 'req_1', '2026-11-12T10:00:02.000Z', {
        input_tokens: 2,
        output_tokens: 177,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 50,
      }),
      assistant('msg_2', 'req_2', '2026-11-12T10:00:03.000Z', {
        input_tokens: 1,
        output_tokens: 3,
      }),
      assistant(
        'msg_3',
        'req_3',
        '2026-11-12T10:00:04.000Z',
        { input_tokens: 0, output_tokens: 0 },
        {
          message: {
            id: 'msg_3',
            model: '<synthetic>',
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
      ),
    ];

    const observations = claudeObservationsFromRecords('sess-1', records);

    expect(observations).toEqual([
      {
        agentTool: 'claude_code',
        sessionId: 'sess-1',
        observationKey: 'req_1',
        observedAt: '2026-11-12T10:00:02.000Z',
        granularity: 'request',
        source: 'harvest',
        model: 'claude-haiku-5-5',
        tokensInput: 2,
        tokensOutput: 177,
        tokensCacheRead: 100,
        tokensCacheCreation: 50,
      },
      expect.objectContaining({ observationKey: 'req_2', tokensOutput: 3 }),
    ]);
    for (const observation of observations) UsageObservationSchema.parse(observation);
  });

  it('falls back to the message id when a record has no request id', () => {
    const [observation] = claudeObservationsFromRecords('s', [
      {
        ...assistant('msg_9', 'x', '2026-11-12T10:00:00.000Z', { output_tokens: 4 }),
        requestId: undefined,
      },
    ]);
    expect(observation.observationKey).toBe('msg_9');
  });

  it('harvests the main transcript and each subagent transcript with its subagent id', () => {
    const projectDir = path.join(claudeRoot, encodeClaudeProjectDir('/repo'));
    writeJsonl(path.join(projectDir, 'sess-1.jsonl'), [
      assistant('msg_1', 'req_1', '2026-11-12T10:00:01.000Z', {
        input_tokens: 1,
        output_tokens: 1,
      }),
    ]);
    writeJsonl(path.join(projectDir, 'sess-1', 'subagents', 'agent-a2c6.jsonl'), [
      assistant(
        'msg_2',
        'req_2',
        '2026-11-12T10:00:02.000Z',
        { input_tokens: 1, output_tokens: 9 },
        {
          agentId: 'a2c6',
          isSidechain: true,
        },
      ),
    ]);
    // A subagent transcript whose records lack agentId: the file name is the id.
    writeJsonl(path.join(projectDir, 'sess-1', 'subagents', 'agent-b7.jsonl'), [
      assistant('msg_3', 'req_3', '2026-11-12T10:00:03.000Z', { output_tokens: 2 }),
    ]);
    fs.writeFileSync(path.join(projectDir, 'sess-1', 'subagents', 'agent-a2c6.meta.json'), '{}');

    const observations = harvestClaudeSessionObservations('sess-1');

    expect(observations.map((o) => [o.observationKey, o.subagentId])).toEqual([
      ['req_1', undefined],
      ['req_2', 'a2c6'],
      ['req_3', 'b7'],
    ]);
  });

  it('never joins a non-UUID-like session id into a path', () => {
    expect(harvestClaudeSessionObservations('../etc/passwd')).toEqual([]);
  });

  it('finds sessions whose transcript cwd is inside a slot work dir', () => {
    const workDir = path.join(tmp, 'worktrees', 'main-abcd-har-agent-2-x1y2');
    writeJsonl(path.join(claudeRoot, encodeClaudeProjectDir(workDir), 'in-slot.jsonl'), [
      { type: 'queue-operation', sessionId: 'in-slot', timestamp: '2026-11-12T09:59:00.000Z' },
      {
        type: 'user',
        sessionId: 'in-slot',
        cwd: path.join(workDir, 'apps'),
        timestamp: '2026-11-12T10:00:00.000Z',
      },
    ]);
    writeJsonl(path.join(claudeRoot, encodeClaudeProjectDir('/repo'), 'in-main.jsonl'), [
      { type: 'user', sessionId: 'in-main', cwd: '/repo', timestamp: '2026-11-12T10:00:00.000Z' },
    ]);

    expect(findClaudeSessionsInWorkDirs([workDir])).toEqual([
      { sessionId: 'in-slot', workDir, firstAt: '2026-11-12T10:00:00.000Z' },
    ]);
  });
});

function sessionMeta(id: string, cwd: string, extra: Record<string, unknown> = {}) {
  return {
    timestamp: '2026-11-12T10:00:00.000Z',
    type: 'session_meta',
    payload: { id, timestamp: '2026-11-12T10:00:00.000Z', cwd, source: 'exec', ...extra },
  };
}

function tokenCount(timestamp: string, last: Record<string, number>, totalTokens: number) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { total_tokens: totalTokens },
        last_token_usage: last,
      },
    },
  };
}

describe('Codex observations', () => {
  const turnA = '01a1d1b1-74aa-7771-b2ec-a308ff092d3e';
  const turnB = '01a1d1b1-9999-7771-b2ec-a308ff092d3e';
  const records = [
    sessionMeta('thread-1', '/repo'),
    {
      timestamp: '2026-11-12T10:00:00.100Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: turnA },
    },
    {
      timestamp: '2026-11-12T10:00:00.200Z',
      type: 'turn_context',
      payload: { turn_id: turnA, model: 'gpt-5.6-luna', cwd: '/repo' },
    },
    tokenCount(
      '2026-11-12T10:00:04.000Z',
      {
        input_tokens: 15791,
        cached_input_tokens: 10240,
        cache_write_input_tokens: 0,
        output_tokens: 138,
        reasoning_output_tokens: 36,
        total_tokens: 15929,
      },
      15929,
    ),
    // Re-emitted with unchanged totals (rate-limit update): not new usage.
    tokenCount(
      '2026-11-12T10:00:04.500Z',
      {
        input_tokens: 15791,
        cached_input_tokens: 10240,
        output_tokens: 138,
        total_tokens: 15929,
      },
      15929,
    ),
    tokenCount(
      '2026-11-12T10:00:09.000Z',
      {
        input_tokens: 16137,
        cached_input_tokens: 15616,
        output_tokens: 199,
        reasoning_output_tokens: 9,
        total_tokens: 16336,
      },
      32265,
    ),
    {
      timestamp: '2026-11-12T10:01:00.000Z',
      type: 'event_msg',
      payload: { type: 'task_started', turn_id: turnB },
    },
    tokenCount('2026-11-12T10:01:05.000Z', { input_tokens: 10, output_tokens: 1 }, 32276),
  ];

  it('emits one turn observation per turn, cached input split out, reasoning not added twice', () => {
    const observations = codexObservationsFromRecords({ sessionId: 'thread-1' }, records);
    expect(observations).toEqual([
      {
        agentTool: 'codex',
        sessionId: 'thread-1',
        observationKey: turnA,
        observedAt: '2026-11-12T10:00:09.000Z',
        granularity: 'turn',
        source: 'harvest',
        model: 'gpt-5.6-luna',
        tokensInput: 15791 - 10240 + (16137 - 15616),
        tokensOutput: 138 + 199,
        tokensCacheRead: 10240 + 15616,
        tokensCacheCreation: 0,
      },
      expect.objectContaining({ observationKey: turnB, tokensInput: 10, tokensOutput: 1 }),
    ]);
    for (const observation of observations) UsageObservationSchema.parse(observation);
  });

  it('numbers turns in order for rollouts written before turn ids', () => {
    const observations = codexObservationsFromRecords({ sessionId: 't' }, [
      { timestamp: '2026-11-12T10:00:00.000Z', type: 'turn_context', payload: { model: 'm' } },
      tokenCount('2026-11-12T10:00:01.000Z', { input_tokens: 5, output_tokens: 1 }, 6),
      { timestamp: '2026-11-12T10:00:02.000Z', type: 'turn_context', payload: { model: 'm' } },
      tokenCount('2026-11-12T10:00:03.000Z', { input_tokens: 7, output_tokens: 1 }, 14),
    ]);
    expect(observations.map((o) => [o.observationKey, o.tokensInput])).toEqual([
      ['turn-1', 5],
      ['turn-2', 7],
    ]);
  });

  it('reports a spawned subagent thread as a subagent of its root thread', () => {
    const day = path.join(codexRoot, '2026', '11', '12');
    writeJsonl(path.join(day, 'rollout-2026-11-12T10-00-00-thread-1.jsonl'), records);
    writeJsonl(path.join(day, 'rollout-2026-11-12T10-02-00-child.jsonl'), [
      sessionMeta('child', '/repo', {
        source: { subagent: { thread_spawn: { parent_thread_id: 'thread-1', depth: 1 } } },
      }),
      {
        timestamp: '2026-11-12T10:02:01.000Z',
        type: 'event_msg',
        payload: { type: 'task_started', turn_id: 'turn-c' },
      },
      tokenCount('2026-11-12T10:02:02.000Z', { input_tokens: 3, output_tokens: 2 }, 5),
    ]);
    writeJsonl(path.join(day, 'rollout-2026-11-12T10-03-00-grandchild.jsonl'), [
      sessionMeta('grandchild', '/repo', {
        source: { subagent: { thread_spawn: { parent_thread_id: 'child', depth: 2 } } },
      }),
    ]);
    writeJsonl(path.join(day, 'rollout-2026-11-12T10-04-00-other.jsonl'), [
      sessionMeta('other', '/elsewhere'),
      tokenCount('2026-11-12T10:04:02.000Z', { input_tokens: 3, output_tokens: 2 }, 5),
    ]);

    const index = indexCodexRollouts();
    expect(codexSessionRef('grandchild', index)).toEqual({
      sessionId: 'thread-1',
      subagentId: 'grandchild',
    });

    const observations = harvestCodexSessionObservations(['thread-1'], index);
    expect(observations.map((o) => [o.sessionId, o.subagentId, o.observationKey]).sort()).toEqual(
      [
        ['thread-1', undefined, turnA],
        ['thread-1', undefined, turnB],
        ['thread-1', 'child', 'turn-c'],
      ].sort(),
    );
  });

  it('finds threads started inside a slot work dir', () => {
    const workDir = path.join(tmp, 'wt');
    writeJsonl(path.join(codexRoot, 'rollout-a.jsonl'), [
      sessionMeta('in-slot', path.join(workDir, 'src')),
    ]);
    writeJsonl(path.join(codexRoot, 'rollout-b.jsonl'), [sessionMeta('in-main', '/repo')]);
    expect(findCodexSessionsInWorkDirs([workDir], indexCodexRollouts())).toEqual([
      { sessionId: 'in-slot', workDir, firstAt: '2026-11-12T10:00:00.000Z' },
    ]);
  });
});
