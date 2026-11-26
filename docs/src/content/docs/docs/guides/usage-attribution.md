---
title: Usage attribution
description: How Mission Control decides which slot an agent's tokens and cost belong to.
---

An agent usually starts in the main checkout, runs `har env launch` to open a
slot, works there, and may move to another slot or back to main. Mission
Control books each piece of LLM usage on the slot the agent was working in
**when that usage happened**, from evidence only. The design is recorded in
[ADR 0003](https://github.com/os-factory/har/blob/main/docs/architecture/decisions/0003-session-slot-attribution.md).

## Two kinds of facts

**Usage observations.** The smallest billable unit each agent reports, with its
own timestamp:

| Agent | Unit | Source |
|---|---|---|
| Claude Code | one turn, and one run of each subagent | `@osfactory/otel-hook` generation spans; tokens read from the session transcript at `Stop` and from the subagent's transcript at `SubagentStop` |
| Codex | one turn | `@osfactory/otel-hook` generation spans |
| Cursor | one generation | `@osfactory/otel-hook` generation spans |

otel-hook is the only source (ADR 0005 section 5). Each unit is keyed by its
`otelhook.generation.id`, so a span delivered twice counts once. A receiver
books the uncached input (otel-hook's input count includes cache reads and
cache writes) and prices the tokens with genai-prices.

**Bindings.** "From time *t*, this session works in slot *N*." HAR creates them
from:

- **launch / release** — `har env launch`, `teardown` or `complete` ran inside
  the session, from the CLI or from the HAR MCP tools. Each agent gives every
  command it runs its session id (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`,
  `CURSOR_CONVERSATION_ID`); HAR records it in the session context and sends
  it to every receiver as a `SessionSegment` record.
  Teardown also releases the session that launched the slot, even when a human
  runs it from a terminal.
- **workspace** — the session itself was started inside the slot's work dir.
- **observed** — a tool event of the session edited or read a file, or ran a
  command, inside the slot's worktree (reported by otel-hook as a branch name and
  a salted hash, never a path).

Each observation goes to the binding in force at its timestamp. Usage with no
binding is the session's **unassigned** usage: planning in the main checkout
before a launch shows as such and is never booked on a slot. Bindings that
arrive late (a record after the spans) re-attribute usage already received.

## What HAR configures

With telemetry on (`har telemetry on`, or at launch), HAR registers otel-hook
for Claude Code, Codex and Cursor. The Claude Code hook command carries
`--claude-transcript-usage` (its turns' and subagents' tokens, read from the
transcripts), `--logs` (the trajectory) and `--metrics`: Claude Code removes
every `OTEL_*` variable from the hooks it runs, so these are flags, not
variables. The Codex hook command carries `--codex-rollout-usage`: Codex's
`Stop` hook reports no tokens, so otel-hook reads each turn's from the session
rollout file, and only when asked to. Which destinations receive logs and metrics still follows each
destination's signals and the telemetry level.

HAR turns no agent's native telemetry on. Earlier versions pointed Claude Code's
own exporter at Mission Control through the `env` block of
`~/.claude/settings.json`; HAR now removes the keys it wrote there (a key you
changed since is left alone), and receivers ignore Claude Code's
`claude_code.api_request` events and `claude_code.*` metrics, so nothing is
counted twice. Codex's native OpenTelemetry (`[otel]` in `~/.codex/config.toml`)
is not configured either.

## Limitations

- **Interleaved worktrees in one context.** An agent alternating between two
  worktrees within a turn has each observation attributed to the worktree it most
  recently touched.
- **Subagents launching slots.** A Claude subagent's commands carry its parent's
  session id, so a launch run by a subagent binds the parent session; the
  subagent's own file events move it to its slot. A Codex subagent is its own
  thread; HAR reports it as a subagent of the root thread.
- **Shell-only work in Claude Code.** Claude's hook `cwd` is the session's, so
  Bash-only work in a worktree is attributed through launch bindings and file
  events.
- **Codex granularity.** A Codex observation is a whole turn, timestamped at its
  last response; a turn that launches a slot is booked on that slot.
- **No offline record.** Usage reaches receivers only through otel-hook: usage
  of a session that ran while the hook was not installed, or while telemetry
  was off, is not recorded.
- **Claude Code granularity.** A Claude Code observation is a whole turn (or a
  whole subagent run), timestamped at its end, not one API request.
- **Cursor** reports no cost: its rows carry tokens and no cost until its model
  ids map to prices HAR can trust.
  Its session env was confirmed from the IDE bundle, not at runtime.
