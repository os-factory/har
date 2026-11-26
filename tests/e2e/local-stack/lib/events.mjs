#!/usr/bin/env node
// Agent events for the local stack end-to-end test (no dependencies; Node >= 20).
//
// No real agent runs here: hook payloads, shaped like Claude Code's and Codex's,
// go through the otel-hook HAR installed, as the agents call it. A Claude Code
// or Codex event runs the exact hook command HAR registered in
// $HOME/.claude/settings.json or $HOME/.codex/hooks.json (with its flags).
// Neither reports usage to a hook: otel-hook reads it from the Claude Code
// transcripts and the Codex rollout written here. Session ids
// are fixed by the caller.
//
//   hook <provider> <event> <session-id> <cwd> [key=value ...]
//       provider: claude-code | codex; event: SessionStart | UserPromptSubmit |
//       PreToolUse | PostToolUse | SubagentStart | SubagentStop | Stop. Keys:
//       transcript, model, turn, usage (JSON), tool (name), file (path),
//       agent (subagent id), agent_type, agent_transcript (path).
//   transcript <file> <session-id> <model> <input> <output> <cache-read> <cache-creation> [agent-id]
//       append one assistant record (Claude Code's transcript shape); with an
//       agent id, a subagent's (sidechain) record
//   rollout <file> <session-id> <model> <input> <cached> <output>
//       append one Codex turn to a rollout file: its model, then the given
//       session running totals; Codex hooks name the file as transcript_path
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [command, ...args] = process.argv.slice(2);

function options(list) {
  const out = {};
  for (const item of list) {
    const index = item.indexOf('=');
    if (index > 0) out[item.slice(0, index)] = item.slice(index + 1);
  }
  return out;
}

function hookPayload(provider, event, sessionId, cwd, opts) {
  const payload = { hook_event_name: event, session_id: sessionId, cwd };
  if (opts.transcript) payload.transcript_path = opts.transcript;
  if (opts.turn) payload.turn_id = opts.turn;
  if (opts.model) payload.model = opts.model;
  // Claude Code puts the subagent's id on every hook a subagent fires.
  if (opts.agent) payload.agent_id = opts.agent;
  if (opts.agent_type) payload.agent_type = opts.agent_type;
  switch (event) {
    case 'SessionStart':
      payload.source = 'startup';
      break;
    case 'UserPromptSubmit':
      payload.prompt = 'Change the greeting in src/greeting.txt.';
      break;
    case 'PreToolUse':
    case 'PostToolUse': {
      const file = opts.file ?? path.join(cwd, 'src', 'greeting.txt');
      payload.tool_use_id = opts.call ?? `tool-${randomBytes(6).toString('hex')}`;
      payload.tool_name = opts.tool ?? (provider === 'codex' ? 'Bash' : 'Edit');
      payload.tool_input =
        provider === 'codex'
          ? { command: `cat ${file}` }
          : payload.tool_name === 'Agent'
            ? { description: 'Look around', prompt: 'Read the greeting.', subagent_type: opts.agent_type ?? 'Explore' }
            : { file_path: file, old_string: 'a', new_string: 'b' };
      if (event === 'PostToolUse') payload.tool_response = { success: true };
      break;
    }
    case 'SubagentStart':
      break;
    case 'SubagentStop':
      payload.stop_hook_active = false;
      if (opts.agent_transcript) payload.agent_transcript_path = opts.agent_transcript;
      payload.last_assistant_message = 'Found it.';
      break;
    case 'Stop':
      payload.stop_hook_active = false;
      payload.last_assistant_message = 'Done.';
      if (opts.usage) payload.usage = JSON.parse(opts.usage);
      if (provider === 'codex') payload.stop_reason = 'completed';
      break;
    default:
      break;
  }
  return payload;
}

/**
 * The command HAR registered for a hook event (`otel-hook setup`), flags
 * included: Claude Code's in ~/.claude/settings.json, Codex's in ~/.codex/hooks.json.
 */
function registeredCommand(home, provider, event, wrapper) {
  const file = provider === 'codex' ? path.join(home, '.codex', 'hooks.json') : path.join(home, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  const commands = (settings.hooks?.[event] ?? []).flatMap((group) => (group.hooks ?? []).map((entry) => entry.command));
  const command = commands.find((value) => typeof value === 'string' && value.includes(wrapper));
  if (!command) throw new Error(`HAR registered no ${event} hook for ${provider} in ${file}`);
  return command;
}

function hook(provider, event, sessionId, cwd, rest) {
  const opts = options(rest);
  const home = process.env.HOME ?? os.homedir();
  const hooksHome = process.env.HAR_OTEL_HOOKS_HOME ?? path.join(home, '.har', 'otel-hooks');
  const wrapper = path.join(hooksHome, 'run-otel-hook.sh');
  if (!fs.existsSync(wrapper)) throw new Error(`no otel-hook wrapper at ${wrapper} (har telemetry install-hooks first)`);
  const payload = hookPayload(provider, event, sessionId, cwd, opts);
  const [file, args] =
    provider === 'claude-code' || provider === 'codex'
      ? ['/bin/sh', ['-c', registeredCommand(home, provider, event, wrapper)]]
      : [wrapper, ['--provider', provider]];
  const result = spawnSync(file, args, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: fs.existsSync(cwd) ? cwd : undefined,
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`hook ${provider} ${event} exited ${result.status}: ${result.stderr}`);
}

function transcript(file, sessionId, model, input, output, cacheRead, cacheCreation, agentId) {
  const id = randomBytes(8).toString('hex');
  const record = {
    type: 'assistant',
    isSidechain: Boolean(agentId),
    ...(agentId ? { agentId } : {}),
    sessionId,
    uuid: `uuid-${id}`,
    parentUuid: null,
    requestId: `req_${id}`,
    timestamp: new Date().toISOString(),
    message: {
      id: `msg_${id}`,
      type: 'message',
      role: 'assistant',
      model,
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Done.' }],
      usage: {
        input_tokens: Number(input),
        output_tokens: Number(output),
        cache_read_input_tokens: Number(cacheRead),
        cache_creation_input_tokens: Number(cacheCreation),
      },
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

/**
 * Append one Codex turn to a rollout file (Codex's session log): the turn's
 * model, then the session's running token totals (the arguments), as Codex
 * writes them. Codex's `Stop` hook carries no usage; otel-hook reads it from
 * here (`--codex-rollout-usage`).
 */
function rollout(file, sessionId, model, input, cached, output) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const timestamp = new Date().toISOString();
  const records = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  const zero = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 };
  const before = records.filter((r) => r.type === 'event_msg' && r.payload?.type === 'token_count').at(-1)?.payload.info.total_token_usage ?? zero;
  const total = {
    input_tokens: Number(input),
    cached_input_tokens: Number(cached),
    output_tokens: Number(output),
    reasoning_output_tokens: 0,
    total_tokens: Number(input) + Number(output),
  };
  const last = Object.fromEntries(Object.entries(total).map(([key, value]) => [key, value - (before[key] ?? 0)]));
  const lines = [
    ...(records.length === 0 ? [{ timestamp, type: 'session_meta', payload: { id: sessionId, timestamp, cwd: process.cwd() } }] : []),
    { timestamp, type: 'turn_context', payload: { cwd: process.cwd(), model } },
    { timestamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: total, last_token_usage: last } } },
  ];
  fs.appendFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}

try {
  if (command === 'hook') hook(args[0], args[1], args[2], args[3], args.slice(4));
  else if (command === 'transcript') transcript(...args);
  else if (command === 'rollout') rollout(...args);
  else throw new Error(`unknown command ${command}`);
} catch (error) {
  console.error(`events: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
