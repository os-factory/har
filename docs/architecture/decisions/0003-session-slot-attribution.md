# ADR 0003: LLM usage is attributed per observation, through an evidence timeline

- Status: Accepted
- Date: 2026-11-12
- Contract: [`packages/schemas/src/session-attribution.ts`](../../../packages/schemas/src/session-attribution.ts)

## Context

HAR's model is that an agent works from the main checkout and uses HAR to open
slots (worktrees). Its LLM usage (tokens and cost) must land on the slot it
worked in, and follow it when it moves to another slot or back to main.

Until now Mission Control decided this once per session, at the session's first
event, and guessed when it could not tell: the repository's only active slot,
else the most recently updated one, else slot 1. Usage was one running total
per session. As a result:

- A session that starts in main and then launches a slot is pinned to whatever
  slot was active at its first event, often a wrong one, for its whole life.
- Several agents working in parallel land on the most recent slot.
- Even a correct pin cannot split one session's cost between main and two slots.

## Decision

### 1. Usage is a stream of observations

The unit is one **usage observation**: the finest billable unit a provider
reports, with its own timestamp. Observations are stored as facts, idempotent on
a producer key, and never merged into each other.

| Agent | Live source | Granularity | Offline source (harvest) |
|---|---|---|---|
| Claude Code | native OTLP log event `claude_code.api_request` (tokens, `cost_usd`, model) | request | session transcript, plus one transcript per subagent (`<session>/subagents/agent-<id>.jsonl`) — per message |
| Codex | native OTLP (`[otel]` in `config.toml`), or otel-hook per-turn usage | turn | rollout `token_count` events (`last_token_usage`) — per turn |
| Cursor | otel-hook spans for `afterAgentResponse` / `stop` (hook payload carries tokens) | generation | none |

Session totals that providers also report (`claude_code.cost.usage`) are kept as
a cross-check against the sum of observations, not as the source of slot cost.

### 2. Slots come from an evidence timeline

A **binding** says "from time t, this session (or one subagent of it) works in
slot N". Mission Control keeps the bindings of every session and attributes each
observation to the binding in force at its timestamp: the latest one for the
subagent, else for its parent session.

Bindings are created only from evidence:

| Kind | Evidence | Producer |
|---|---|---|
| `launch` / `release` | `har env launch`, `teardown` or `complete` ran inside the session. Each agent gives every command it runs its session id: `CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, `CURSOR_CONVERSATION_ID`. | HAR CLI and MCP, via sync |
| `workspace` | The session itself runs inside the slot's work dir. | Mission Control, from span workspace |
| `observed` | A tool event targeted a file or ran a command inside the slot's worktree. | otel-hook span attributes (`vcs.ref.head.name`, hashed worktree id) |

With no binding, an observation is the session's **unassigned** usage: it was
spent in the main checkout, and it is shown as such. Mission Control never books
it on a slot and never guesses a slot.

### 3. Slot usage is derived

Per-slot and per-session usage is computed from observations and bindings,
never written once. Evidence that arrives late, such as a launch record synced
after the spans, corrects the attribution of usage already received.

### 4. Wire format

All types live in `packages/schemas/src/session-attribution.ts`.

- `POST /api/repos/{id}/session-bindings` — `SyncSessionBindingsInput`; idempotent
  per `(agentTool, sessionId, subagentId, kind, slotId, at)`. `GET` lists them.
- `POST /api/repos/{id}/usage-observations` — `SyncUsageObservationsInput`;
  idempotent per `(agentTool, sessionId, observationKey)`. `GET` lists them.
- OTLP (`/api/otel/v1/{logs,metrics,traces}`) observations and bindings are
  produced inside Mission Control from the same types.
- `har control sync` posts bindings and harvested observations; slot usage read
  through the existing `/usage` route is the derived projection.

## Consequences

- An agent that works in several slots, in sequence or across sessions in
  parallel, has its usage split between them exactly.
- Usage spent planning in main before a launch stays visible as unassigned
  instead of inflating the first slot.
- otel-hook resolves the targeted worktree locally (in its core, not in provider
  adapters; see otel-hook ADR 0003) and exports only a branch name and a salted
  hash, never a path.
- Claude Code needs its OTLP logs exporter enabled. HAR enables only the
  per-request event stream; prompt and tool-content logging stay off.

## Known limitations

- **Interleaved worktrees in one context.** One agent (or subagent) alternating
  between two worktrees within a turn has each observation attributed to the
  worktree it most recently touched. Timestamps cannot separate them further.
- **Subagents launching slots.** The session id in a subagent's commands is
  its parent's, so a `launch` run by a subagent binds the parent session; the
  subagent's own `observed` bindings move it to its slot from its first tool
  event in the worktree.
- **Shell-only work.** A command run in a worktree is evidence only where the
  provider reports the command's working directory (Cursor, Codex). Claude
  Code's hook `cwd` is the session's, so Bash-only work in a worktree is
  attributed through `launch` bindings and file-tool events.
- **Cursor** reports no cost and no offline record; its cost is estimated from
  model prices, and usage missed while otel-hook was not installed is lost.

## Verified

Spikes run on 2026-11-12 against a throwaway local OTLP/HTTP JSON receiver
(cheapest models, one-line prompts). Field and env names only.

### Claude Code 2.1.322

- **Session env.** Every Bash command gets `CLAUDE_CODE_SESSION_ID`; its value
  equals `session.id` on every OTLP event and the transcript's file name
  (`~/.claude/projects/<encoded cwd>/<session.id>.jsonl`). A subagent's
  commands see the **parent** session id (confirms "Subagents launching slots").
- **MCP launches.** A stdio MCP server spawned by Claude Code inherits
  `CLAUDE_CODE_SESSION_ID` in its process env, so `har_launch_environment` via
  the HAR MCP server binds the same way as the CLI. Requests carry no session
  id (`tools/call` `_meta` has only `claudecode/toolUseId`, `progressToken`).
  Not verified: whether a long-lived MCP server's env follows a session id
  change inside one Claude process (`/clear`, resume).
- **`claude_code.api_request`** (logs exporter; scope
  `com.anthropic.claude_code.events`; body `claude_code.api_request`;
  `event.name` = `api_request`). Attributes: `session.id`, `prompt.id`,
  `request_id`, `client_request_id`, `model`, `input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_creation_tokens`, `cache_creation_5m_tokens`,
  `cache_creation_1h_tokens`, `cost_usd`, `cost_usd_micros`, `duration_ms`,
  `ttft_ms`, `speed`, `effort`, `query_source` (`sdk` in `-p` mode, or
  `agent:builtin:<name>` for a subagent), `event.timestamp`, `event.sequence`,
  optionally `mcp_server.name` / `mcp_tool.name`; a subagent's requests add
  `agent_id` and `agent.name`. Identity attributes (`user.*`,
  `organization.id`) are present on every event. Other events on the same
  stream: `user_prompt`, `assistant_response`, `tool_decision`, `tool_result`,
  `mcp_server_connection`, `plugin_loaded`, `managed_settings_resolved`.
- **Transcripts.** Assistant records carry `requestId`, `message.id`,
  `message.model`, `message.usage` (`input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`), `timestamp`,
  `isSidechain`, `cwd`. One message is split across several records that repeat
  its usage. Subagent transcripts are
  `<session.id>/subagents/agent-<agentId>.jsonl` (plus `agent-<agentId>.meta.json`);
  their records add `agentId` and `isSidechain: true`.
- **Join keys.** Transcript `requestId` = OTLP `request_id`; transcript
  `agentId` = OTLP `agent_id` = subagent file name. Claude observations
  therefore use `observationKey = request_id` (harvest falls back to
  `message.id` only when a record has no `requestId`), so a harvested
  observation and a live one are the same fact. `cost_usd` exists only on the
  live event: Mission Control must not let a harvested copy erase it.

### Codex 0.163.0

- **Session env.** Commands get `CODEX_THREAD_ID` and `CODEX_SESSION_ID`, both
  equal to the rollout id (`session_meta.payload.id`, the
  `rollout-<ts>-<id>.jsonl` suffix).
- **Rollout usage.** `event_msg` / `token_count` is emitted per model response,
  not per turn (two in a one-turn spike), with `info.last_token_usage` and
  `info.total_token_usage` (`input_tokens`, `cached_input_tokens`,
  `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`,
  `total_tokens`). `input_tokens` includes cached input and `total_tokens` =
  input + output, so reasoning is already inside `output_tokens`. The turn id is
  on `event_msg` / `task_started` and `turn_context` (`turn_id`, plus `model`,
  `cwd`). Newer rollouts add a `token_usage_record` per response with
  `thread_id`, `turn_id`, `response_id`, `usage`.
- **Subagents.** A spawned agent is its own rollout whose
  `session_meta.payload.source.subagent.thread_spawn.parent_thread_id` names its
  parent thread; its commands get its **own** thread id. HAR reports it as a
  subagent (`subagentId` = its thread id) of the root thread, for both
  observations and bindings.
- **Native OTel** (`[otel]` with `otlp-http`, `protocol = "json"`):
  - logs: `codex.sse_event` with `event.kind = response.completed` carries
    `input_token_count`, `output_token_count`, `cached_token_count`,
    `cache_write_token_count`, `reasoning_token_count`, `tool_token_count`,
    `model` and `conversation.id` (= thread id), but **no turn or response id**,
    and the spike saw one more `response.completed` than the rollout has
    responses;
  - traces: span `session_task.turn` carries `turn.id`, `thread.id`, `model`
    and `codex.turn.token_usage.*`; per-response `handle_responses` spans carry
    `gen_ai.usage.*` with no thread id; most spans are Codex internals;
  - metrics: histogram `codex.turn.token_usage` has no session id.

  HAR therefore does **not** configure Codex's native OTel: no signal has both a
  session id and a per-unit id that matches the rollout, so live and harvested
  observations could not be told apart, and the trace stream would land
  Codex-internal spans in Mission Control. Codex usage reaches Mission Control
  through otel-hook (live) and rollout harvest, one observation per turn keyed
  by `turn_id`.

### Cursor

`cursor-agent` is not installed on the spike machine; not verified at runtime.
Evidence from the IDE bundle (`/usr/share/cursor/resources/app`): agent shell
commands get `CURSOR_CONVERSATION_ID` (shell-quoted, hence the quote stripping
in `launchingAgentSession`) and `CURSOR_REQUEST_ID`.
