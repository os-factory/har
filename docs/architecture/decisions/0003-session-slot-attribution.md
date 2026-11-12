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
