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

**Nested agents.** Agents pass their variables down: Codex run from a Claude
Code shell, or Claude Code started from a Cursor agent terminal, sees both
agents' session variables. The session belongs to the innermost agent, which HAR
finds by walking up its process tree to the nearest agent process whose variable
is set (`src/core/agent-process.ts`). When several variables are set and the tree
cannot settle it, no `launch` is recorded — never the wrong session.

**Slot evidence that arrives before its slot.** Mission Control learns a slot
occupancy's branch and work dir from the CLI's slot and work-attempt sync. A
tool event that targets the worktree before that sync (Mission Control down at
launch, the repository outside the saved sync selection, or plain ordering) is
stored as a non-slot worktree binding. When the sync then names that branch or
work dir, Mission Control moves those bindings onto the occupancy, from the
occupancy's start on, and places the session's main-checkout spans, events and
trajectory rows from then on again through the timeline
(`control/src/server/late-slot-evidence.ts`). A branch carries a per-occupancy
suffix, so the match is evidence, not a guess.

With no binding, an observation is the session's **unassigned** usage: it was
spent in the main checkout, and it is shown as such. Mission Control never books
it on a slot and never guesses a slot.

### 3. Slot usage is derived

Per-slot and per-session usage is computed from observations and bindings,
never written once. Evidence that arrives late, such as a launch record synced
after the spans, corrects the attribution of usage already received.

How Mission Control resolves the timeline:

- **In force at t:** the latest `launch` or `observed` binding at or before t,
  for the subagent, else for its parent session. A `workspace` binding (the
  session's own cwd, including otel-hook's `otelhook.target.source =
  session-cwd`) repeats on every event, so it counts from its *first* sighting
  per occupancy and never overrides a stronger binding made after that.
- **Release:** a `release` of slot N, from any session, ends N's occupancy. It
  closes bindings to that occupancy (including ones recorded after it with the
  same occupancy key) and leaves bindings to other slots alone, so tearing down
  another slot does not move a session to main. A subagent whose own binding
  is closed falls back to its parent's.
- **Occupancy:** a binding never outlives its occupancy. Besides releases, the
  start of a different known occupancy of the slot (a slot row, a work
  attempt, another `launch` / `workspace` binding with another key) closes it.
  A binding that names the slot's current branch but no occupancy key gets the
  slot's current occupancy key when stored.
- **Non-slot worktrees:** a session working in a linked git worktree that is
  not a slot is bound to it as `MAIN_CHECKOUT_AGENT_ID` (0) with an occupancy
  key naming the worktree (`worktree:<path>`, or `worktree-branch:<branch>`).
  Evidence: the session's cwd inside one of the repository's linked worktrees
  (read from `.git/worktrees/*`, no git spawn; a worktree outside the checkout
  also resolves the repository), or a tool event's
  `otelhook.target.workspace.id` matching one (otel-hook ADR 0008). When
  Mission Control cannot read the repository's git directory, a target that is
  neither the main checkout's nor a slot's hash is named by its
  `vcs.ref.head.name` alone. Such usage stays unassigned — never a slot's —
  but is split per worktree (`workDir`, `branch`); worktree bindings never
  close each other or a slot's.
- **Same unit, several producers:** observations are idempotent per key. A
  repeat of a key from the live stream replaces a harvested copy; a harvested
  copy never replaces the live one, and a provider-reported cost is never
  erased by a repeat without one. Claude keys by API request id (`request_id`
  = transcript `requestId`); Codex by `turn_id` (`otelhook.generation.id` =
  rollout turn id); Cursor by `generation_id`. Streams that key the same units
  differently (an otel-hook build without `otelhook.generation.id`, Codex
  native `sse_event`) are de-duplicated by time: within a session the
  highest-priority stream owns the window it covers, lower ones only fill the
  time outside it.
- **Running totals:** Codex hook usage is the session's running total
  (`otelhook.usage.temporality = cumulative`). Mission Control stores the
  reported total with the turn and the turn's own usage as the difference from
  the previous reported total, less the turns stored in between without one
  (harvested only). A turn arriving out of order recomputes the next one.
- **Cost:** the provider's cost when reported (Claude `cost_usd`), else the
  genai-prices estimate for the observation's model and tokens.
- **Provider totals:** Claude's `claude_code.cost.usage` / `token.usage`
  metrics are stored per session (`SessionReportedUsage`) and shown as a
  cross-check against the sum of the session's observations. A session with a
  reported total and no observation yet is listed with the unassigned usage as
  "not itemized"; it is never booked on a slot. Codex `codex.turn.token_usage`
  metrics carry no thread id and are not used.
- **Legacy session totals:** `AgentSessionUsage` rows (one max-merged total per
  session, from `POST /usage` and earlier OTLP ingest) stay as they are unless
  observations of the same agent tool cover them — same session id, or an
  overlapping time window, since legacy rows are often keyed by slot branch.
  Covered rows are superseded by the projection; uncovered ones keep their
  stored slot. `POST /usage` skips rows with `agentId` 0 instead of rejecting
  the batch.

### 3a. Spans, events and trajectory records

Trajectory records are immutable facts, placed once at ingest: the record's
own evidence joins its session's timeline and the record goes to the binding
in force at its timestamp, else to the main checkout, stored as `agentId` 0
(`MAIN_CHECKOUT_AGENT_ID`; the trajectory record schema now allows it). The
repository's only active slot, the most recent slot, slot 1 and the slot of
the session's first event are no longer used. Unlike usage, placement is not
recomputed when a binding arrives late (see Known limitations), except when
the late evidence is the slot itself (section 2): then rows placed on the main
checkout are placed again. Per-request
usage events (`claude_code.api_request`, Codex `sse_event`) become
observations only, not trajectory records.

### 4. Wire format

All types live in `packages/schemas/src/session-attribution.ts`.

- `POST /api/repos/{id}/session-bindings` — `SyncSessionBindingsInput`; idempotent
  per `(agentTool, sessionId, subagentId, kind, slotId, at)`. `GET` lists them.
- `POST /api/repos/{id}/usage-observations` — `SyncUsageObservationsInput`;
  idempotent per `(agentTool, sessionId, observationKey)`. `GET` lists them.
- OTLP (`/api/otel/v1/{logs,metrics,traces}`) observations and bindings are
  produced inside Mission Control from the same types.
- `har control sync` posts bindings and harvested observations; slot usage read
  through the existing `/usage` route is the derived projection, with the
  `unassigned` usage (per session, and per non-slot worktree: `workDir` /
  `branch`, null for the main checkout) and `crossChecks` beside it. Every
  usage and unassigned row carries `changedAt`: the latest stored observation
  or binding of its session (a slot's `launch` / `release` also touches every
  session bound to that slot).
- Mission Control persists them as `SessionSlotBinding`, `UsageObservation`
  and `SessionReportedUsage` (SQLite, applied by `prisma db push` like every
  Mission Control schema change).

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
  provider reports the command's working directory: Cursor, and only with its
  `beforeShellExecution` hook registered. Claude Code and Codex hooks carry the
  session's `cwd`, not the command's (verified for Codex 0.163.0 with an explicit
  `workdir`), so their shell-only work in a worktree is attributed through
  `launch` bindings and file-tool events (Claude file tools, Codex `apply_patch`).
- **Cursor subagents** carry no subagent id in otel-hook yet: Cursor does not
  document which conversation id a subagent's hooks carry, so a Cursor subagent
  is attributed with its parent session.
- **Cursor** reports no cost and no offline record; its cost is estimated from
  model prices, and usage missed while otel-hook was not installed is lost.
- **Trajectory placement is re-attributed only for a late slot.** A span that
  arrives before the binding that explains it (a launch synced late) stays in
  the main checkout's trajectory; its usage is re-attributed, its timeline row
  is not. Rows that arrived before their slot itself was known are placed again
  when the slot syncs, but a copy already forwarded to HAR HQ keeps its first
  placement.
- **Legacy rows are joined by time.** A pre-observation `AgentSessionUsage`
  row that overlaps observations of the same agent tool is hidden, even when it
  belonged to another, unobserved session running in parallel.
- **Live-stream gaps.** Within the window a live stream covers, a unit it
  missed is recovered only when the harvest reports it under the same key.
- **Read cost.** Slot usage is derived on every read from all of a
  repository's observations; there is no materialized projection yet.

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

### Live end-to-end (ghostfolio, 2026-11-12)

- **Claude Code**: a `claude -p` session read a file in main, launched slot 2,
  then read a file in the slot. Mission Control recorded `launch` (from
  `CLAUDE_CODE_SESSION_ID`) and `observed` (Read, `tool-path`) bindings; the two
  requests before the launch stayed unassigned and the two after it landed on
  slot 2, summing exactly to Claude's own session total.
- **Codex**: a `codex exec` session launched slot 3 and wrote a file there with
  `apply_patch`. otel-hook's `tool-path` evidence produced an `observed`
  binding to slot 3. Its single turn (harvested, 19,315 input / 417 output
  tokens, cost estimated) landed on slot 3 whole: per-turn granularity cannot
  separate the part of a turn spent in main. The run was started from a Claude
  Code shell, which exposed the nested-agents case above.

### Cursor

`cursor-agent` is not installed on the spike machine; not verified at runtime.
Evidence from the IDE bundle (`/usr/share/cursor/resources/app`): agent shell
commands get `CURSOR_CONVERSATION_ID` (shell-quoted, hence the quote stripping
in `launchingAgentSession`) and `CURSOR_REQUEST_ID`.

## Downstream mirror: har-portal (FE-2058)

The portal never attributes. Mission Control is the one place that attributes
and prices usage; `har control sync` ships its rows to the portal unchanged, in
the existing `/api/sync` `usage[]` record (`AgentSessionUsage`), plus one
optional field, `providerSessionId`. The portal stores them as they are and,
for every provider session a sync carries, **replaces** that session's rows —
so usage a late launch record moves from the main checkout to a slot leaves the
main checkout.

- **Rows.** One per bucket of a provider session, `providerSessionId` set:

  | Where                     | `agentId` | `workDir` / `branch` | `sessionKey`                       |
  |---------------------------|-----------|----------------------|------------------------------------|
  | main checkout             | 0         | null / null          | `<session>@main`                   |
  | non-slot git worktree     | 0         | its path / branch    | `<session>@wt:<branch ?? workDir>` |
  | slot occupancy            | slot      | as Mission Control derives (with `workUnitId`, `attemptId`) | `<session>@<slot>:<occupancyKey ?? ''>` |
  | provider total, no unit   | 0         | null / null          | `<session>@reported`               |

  `costUsd` is Mission Control's (provider cost, else the genai-prices
  estimate) and is never repriced; `modelBreakdown` / `models[]`, `sources`
  and `harvestVersion` are Mission Control's too; `userEmail` is the syncing
  member. Legacy session totals Mission Control still counts travel as stored,
  without `providerSessionId`.
- **Completeness.** A sync sends a session whole or not at all: every current
  row of each session whose `changedAt` passed the portal watermark (first sync
  and `--full`: everything). Requests are batched by size, never splitting a
  session.
- **Compatibility.** A Mission Control whose usage view has no `unassigned`
  list predates attribution: the portal then gets the legacy per-slot totals
  (local harvest, lowest slot taking main-checkout sessions, max-merged and
  repriced), as before. If the usage view cannot be read, the sync sends no
  usage and holds the watermark.
- **Superseded.** 1.24.0 sent the facts to `POST /api/session-attribution` and
  exported the attribution core as `@osfactory/har/attribution` for the portal
  to derive usage itself. Both are gone, with the Mission Control routes that
  fed them (`usage-observations/changes`, `reported-usage`, paged
  `session-bindings`).
