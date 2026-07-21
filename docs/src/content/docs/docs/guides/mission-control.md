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

## Agent usage telemetry (Claude Code / Codex)

HAR can attribute Claude Code and Codex token usage (and Claude cost estimates) to
each worktree/session and show it in Mission Control. Preference shape:

```json
{ "enabled": true, "signals": { "metrics": true, "logs": true, "prompts": false, "traces": false } }
```

Defaults when telemetry is on: **metrics + logs** (events without prompt bodies).
Prompt text is **opt-in**.

```bash
har telemetry status
har telemetry on              # metrics + logs; ensure Mission Control is running
har telemetry on --prompts    # also ship user/assistant text to local MC
har telemetry on --traces     # thin traces + Claude enhanced telemetry beta
har telemetry off             # stop OTEL injection and usage harvest; keeps historical rows
```

Preference is stored in `~/.har/telemetry.json`. Override with `HAR_TELEMETRY=0|1`.

When telemetry is on:

1. `har env launch` auto-starts Mission Control if it is not reachable (`har control up`).
2. Launch writes session tags and OTEL exporter env into `.env.agent.<id>` (Claude Code),
   including `OTEL_LOGS_EXPORTER=otlp` when logs are enabled.
3. Agents export metrics to `{HAR_CONTROL_API_URL}/api/otel/v1/metrics` and logs to
   `/api/otel/v1/logs` (traces to `/api/otel/v1/traces` when opted in).
4. `har control sync` also **harvests** local Claude/Codex session files as a fallback
   (prompt summaries only when `signals.prompts` is true).

**Privacy:** prompt/response text leaves the agent machine only when the prompts
signal is on. Mission Control stores usage and events in local SQLite.

For Codex, print a config snippet (merge into `~/.codex/config.toml` yourself):

```bash
har telemetry codex-snippet --agent-id 1 --write
```

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
