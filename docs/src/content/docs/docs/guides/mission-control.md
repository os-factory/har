---
title: Mission Control
description: Observe local repositories, worktrees, runs, validations, and artifacts.
---

Mission Control is HAR's open-source local dashboard. It combines run records and
slot state from registered repositories without replacing the repository-owned
harness.

## Start the packaged dashboard

```bash
har control up
```

The CLI pulls the Mission Control image matching its own version and starts the app
plus PostgreSQL with Docker Compose. Build the image from a source checkout instead:

```bash
har control up --build
```

Stop it with `har control down`.

## Register and sync

`har env init` remembers a repository for synchronization. You can also register
one explicitly:

```bash
har control register --repo /path/to/project
har control sync --repo /path/to/project
har control watch --interval 10
```

`watch` can sync one repository or all registered repositories continuously.
`--dry-run` previews registration or sync, and `sync --json` produces structured
output.

## Unregister

Remove a repository from Mission Control (and stop auto-sync) from the CLI or the
repo detail page (**Unregister**):

```bash
har control unregister --repo /path/to/project
# non-interactive:
har control unregister --repo /path/to/project --yes --delete-worktrees
```

Unregister deletes synced runs/slots/telemetry for that path and records a
blocklist entry so background sync does not immediately re-add it. The CLI
proposes deleting session worktrees; confirm interactively or pass
`--delete-worktrees`. The dashboard checkbox does the same, but the packaged
Docker image often cannot see host worktree paths — use the CLI when host cleanup
is required. Re-register with `har control register`.

## What the dashboard shows

The repository overview summarizes registered projects, total runs, active slots,
and harness profiles. Repository detail provides:

- active slots, worktrees, branches, preview URLs, dirtiness, and drift;
- a run timeline with stage, trigger, duration, and status;
- expected validation stages and their latest results;
- exact-tree change batches and associated commits;
- files under `.har/artifacts/`;
- verification trends and pass rates.

The global **Worktrees** home page (`/`) highlights dirty, stale, detached, and
bypass-warning sessions across repositories. It also shows **token and cost**
columns when agent telemetry is enabled (see below). Click a slot id for the
slot leaf (LLM usage + Verify pipeline + session timeline). Repo catalog lives
at `/repos`; cross-repo usage rollup at `/usage`.

## Agent usage telemetry (Cursor / Claude / Codex)

HAR attributes Cursor, Claude Code, and Codex activity to each worktree/session via
[opentelemetry-hooks](https://github.com/o11y-dev/opentelemetry-hooks) and shows it in
Mission Control. Preference shape:

```json
{ "enabled": true, "signals": { "metrics": true, "logs": true, "prompts": false, "traces": true } }
```

Defaults when telemetry is on: **traces + logs + derived metrics** (events without prompt
bodies). Prompt text is **opt-in** and also fills the Mission Control **purpose** column
from the first captured user prompt.

```bash
har telemetry status
har telemetry on              # ensure Mission Control + install/configure opentelemetry-hooks
har telemetry on --prompts    # also ship user prompt text (session purpose)
har telemetry install-hooks   # re-run Cursor / Claude / Codex hook registration
har telemetry off             # clear hooks OTLP export + stop MC auto-start; keeps historical rows
```

Preference is stored in `~/.har/telemetry.json`. Override with `HAR_TELEMETRY=0|1`.
Hooks config lives at `~/.har/otel-hooks/otel_config.json` (`HAR_OTEL_HOOKS_HOME` to override).

When telemetry is on:

1. `har env launch` auto-starts Mission Control if it is not reachable (`har control up`).
2. `har telemetry on` installs `opentelemetry-hooks` and registers Cursor / Claude / Codex hooks
   to export OTLP `http/json` to `{HAR_CONTROL_API_URL}/api/otel`.
3. Launch writes session attribution into `.env.agent.<id>` (`HAR_SESSION_KEY`, resource attrs).
   Mission Control matches sessions by `har.session_key` or by workspace/cwd → slot work dir.
4. Token usage is derived from span `gen_ai.usage.*` attributes. `har control sync` also
   **harvests** local Claude/Codex session files as a fallback when hooks telemetry is missing.

**Privacy:** prompt text leaves the agent machine only when the prompts signal is on.
Mission Control stores usage and events in local SQLite.

Disable anytime: `har telemetry off`.

## Local development

Mission Control's source has its own harness:

```bash
cd control
har env launch 1
```

Use this path for development, manual testing, and screenshots. Do not run it on the
same port as the packaged `har control up` instance. Harness preflight detects the
conflict and can select another port in the slot lane.

## HAR Cloud

`har control login --api-key ...` configures a hosted API key for the current
process, and `har control sync --cloud` targets HAR Cloud. Hosted coordination is
separate from the local open-source dashboard and portable `.har/` contract.
