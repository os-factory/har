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

| Agent | Unit | Live | Offline (`har control sync`) |
|---|---|---|---|
| Claude Code | one API request | native OTLP event `claude_code.api_request` | session transcript, plus one transcript per subagent |
| Codex | one turn | `@osfactory/otel-hook` | rollout `token_count` events, per turn |
| Cursor | one generation | `@osfactory/otel-hook` | none |

A live and a harvested copy of the same unit share one key (Claude's request id,
Codex's turn id), so they never count twice.

**Bindings.** "From time *t*, this session works in slot *N*." HAR creates them
from:

- **launch / release** — `har env launch`, `teardown` or `complete` ran inside
  the session, from the CLI or from the HAR MCP tools. Each agent gives every
  command it runs its session id (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`,
  `CURSOR_CONVERSATION_ID`); HAR records it next to the slot in
  `.har/session-bindings/` (git-ignored) and `har control sync` sends it.
  Teardown also releases the session that launched the slot, even when a human
  runs it from a terminal.
- **workspace** — the session itself was started inside the slot's work dir.
- **observed** — a tool event of the session edited or read a file, or ran a
  command, inside the slot's worktree (reported by otel-hook as a branch name and
  a salted hash, never a path).

Each observation goes to the binding in force at its timestamp. Usage with no
binding is the session's **unassigned** usage: planning in the main checkout
before a launch shows as such and is never booked on a slot. Bindings that
arrive late (a sync after the spans) re-attribute usage already received.

## What HAR configures

With telemetry on (`har telemetry on`, or at launch), HAR writes to the `env`
block of `~/.claude/settings.json`:

- `CLAUDE_CODE_ENABLE_TELEMETRY=1`
- the OTLP **logs** exporter (`OTEL_LOGS_EXPORTER`, `OTEL_EXPORTER_OTLP_LOGS_*`,
  `OTEL_LOGS_EXPORT_INTERVAL`) to `{HAR_CONTROL_API_URL}/api/otel/v1/logs`, for
  the per-request `claude_code.api_request` events;
- the OTLP **metrics** exporter to `/api/otel/v1/metrics`, kept as a cross-check
  of session totals.

HAR never sets `OTEL_LOG_USER_PROMPTS` or `OTEL_LOG_TOOL_DETAILS`, so prompt
text and tool content stay out of these events. A key you set to another value
is left alone (HAR warns when it sets telemetry up), and `har telemetry off` removes
only the keys HAR wrote.

Codex's native OpenTelemetry (`[otel]` in `~/.codex/config.toml`) is **not**
configured: its log events carry no turn or response id and its metrics no
session id, so they could not be matched with harvested turns. Codex usage
comes from otel-hook and the rollout harvest.

## Which sessions `har control sync` harvests

Only sessions the repository has evidence for: sessions with a binding in this
repository (recorded locally or known to Mission Control), and sessions whose
transcript or rollout was started inside an active slot's work dir. A session
that never touched HAR is not read.

When Mission Control is older than this attribution model (no
`/session-bindings` or `/usage-observations` route), sync warns once and falls
back to per-slot totals for sessions that ran inside a slot's work dir.

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
- **Cursor** reports no cost and keeps no offline record: its cost is estimated
  from model prices, and usage missed while otel-hook was not installed is lost.
  Its session env was confirmed from the IDE bundle, not at runtime.
