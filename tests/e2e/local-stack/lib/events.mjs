#!/usr/bin/env node
// Agent events for the local stack end-to-end test (no dependencies; Node >= 20).
//
// No real agent runs here: hook payloads, shaped like Claude Code's and Codex's,
// go through the otel-hook HAR installed (its wrapper, as the agents call it),
// and Claude Code's own usage events go where HAR pointed Claude Code's native
// telemetry (~/.claude/settings.json). Session ids are fixed by the caller.
//
//   hook <provider> <event> <session-id> <cwd> [key=value ...]
//       provider: claude-code | codex; event: SessionStart | UserPromptSubmit |
//       PreToolUse | PostToolUse | Stop. Keys: transcript, model, turn,
//       usage (JSON), tool (name), file (path).
//   transcript <file> <session-id> <model> <input> <output> <cache-read> <cache-creation>
//       append one assistant record (Claude Code's transcript shape)
//   claude-native <session-id> <model> <input> <output> <cache-read> <cache-creation> <cost-usd> <request-id>
//       one `claude_code.api_request` log record, OTLP/JSON, to the logs endpoint
//       in $HOME/.claude/settings.json (exit 3 when HAR configured none)
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
      payload.tool_use_id = `tool-${randomBytes(6).toString('hex')}`;
      payload.tool_name = opts.tool ?? (provider === 'codex' ? 'Bash' : 'Edit');
      payload.tool_input =
        provider === 'codex' ? { command: `cat ${file}` } : { file_path: file, old_string: 'a', new_string: 'b' };
      if (event === 'PostToolUse') payload.tool_response = { success: true };
      break;
    }
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

function hook(provider, event, sessionId, cwd, rest) {
  const opts = options(rest);
  const home = process.env.HOME ?? os.homedir();
  const hooksHome = process.env.HAR_OTEL_HOOKS_HOME ?? path.join(home, '.har', 'otel-hooks');
  const wrapper = path.join(hooksHome, 'run-otel-hook.sh');
  if (!fs.existsSync(wrapper)) throw new Error(`no otel-hook wrapper at ${wrapper} (har telemetry install-hooks first)`);
  const payload = hookPayload(provider, event, sessionId, cwd, opts);
  const result = spawnSync(wrapper, ['--provider', provider], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: fs.existsSync(cwd) ? cwd : undefined,
    timeout: 30_000,
  });
  if (result.status !== 0) throw new Error(`hook ${provider} ${event} exited ${result.status}: ${result.stderr}`);
}

function transcript(file, sessionId, model, input, output, cacheRead, cacheCreation) {
  const id = randomBytes(8).toString('hex');
  const record = {
    type: 'assistant',
    isSidechain: false,
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

function attr(key, value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { key, value: { intValue: String(value) } } : { key, value: { doubleValue: value } };
  }
  return { key, value: { stringValue: String(value) } };
}

async function claudeNative(sessionId, model, input, output, cacheRead, cacheCreation, cost, requestId) {
  const home = process.env.HOME ?? os.homedir();
  const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
  const env = settings.env ?? {};
  const endpoint = env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  if (env.CLAUDE_CODE_ENABLE_TELEMETRY !== '1' || !endpoint) {
    console.error('claude-native: HAR configured no Claude Code native logs export');
    process.exit(3);
  }
  const resource = [attr('service.name', 'claude-code'), attr('service.version', '2.1.150')];
  for (const pair of (env.OTEL_RESOURCE_ATTRIBUTES ?? '').split(',').filter(Boolean)) {
    const index = pair.indexOf('=');
    if (index > 0) resource.push(attr(pair.slice(0, index).trim(), pair.slice(index + 1).trim()));
  }
  const now = new Date();
  const body = {
    resourceLogs: [
      {
        resource: { attributes: resource },
        scopeLogs: [
          {
            scope: { name: 'com.anthropic.claude_code.events', version: '2.1.150' },
            logRecords: [
              {
                timeUnixNano: String(BigInt(now.getTime()) * 1_000_000n),
                observedTimeUnixNano: String(BigInt(now.getTime()) * 1_000_000n),
                body: { stringValue: 'claude_code.api_request' },
                attributes: [
                  attr('event.name', 'api_request'),
                  attr('event.timestamp', now.toISOString()),
                  attr('session.id', sessionId),
                  attr('model', model),
                  attr('input_tokens', Number(input)),
                  attr('output_tokens', Number(output)),
                  attr('cache_read_tokens', Number(cacheRead)),
                  attr('cache_creation_tokens', Number(cacheCreation)),
                  attr('cost_usd', Number(cost)),
                  attr('duration_ms', 1200),
                  attr('request_id', requestId),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`claude-native: POST ${endpoint}: ${response.status} ${await response.text()}`);
}

try {
  if (command === 'hook') hook(args[0], args[1], args[2], args[3], args.slice(4));
  else if (command === 'transcript') transcript(...args);
  else if (command === 'claude-native') await claudeNative(...args);
  else throw new Error(`unknown command ${command}`);
} catch (error) {
  console.error(`events: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
