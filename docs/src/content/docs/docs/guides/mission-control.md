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
```

Sync also runs automatically at every activity edge — login, launch, verify,
commit, complete — so registered repositories stay current without a manual
`sync` or a background watcher. `--dry-run` previews registration or sync, and
`sync --json` produces structured output.

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

## Clear all data (factory reset)

To wipe the entire Mission Control database (and optionally scrub local harness
history so a later register/sync starts empty), use **Settings → Danger zone** in
the dashboard, or the CLI:

![Mission Control Settings danger zone with clear-all confirmation sheet](/assets/mission-control-reset.png)

```bash
har control reset
# non-interactive:
har control reset --yes
```

Reset deletes every repository row (runs, slots, validations, telemetry cascade)
and clears the unregister blocklist. Cloud / portal credentials are kept.
With local scrub enabled (default), it also removes `.har/runs`,
`.har/validations`, `.har/state`, and `.har/slots` under each registered
repository, and clears `~/.har/repos.json`. Packaged Docker Mission Control may
not see host paths — prefer the CLI when host scrubbing is required.
Re-register afterward with `har control register`.

## Factory: work and evidence

Factory is the default Mission Control experience. It answers four questions:

1. What durable piece of work is this?
2. Which isolated attempt executed it?
3. What ran, how long did it take, and what did the agent cost?
4. Which exact Git tree passed full verification?

![Mission Control Factory overview showing completed and active work units](/assets/factory-overview.png)

Launch with a short work identifier plus source metadata to create that evidence chain:

```bash
har env launch 1 \
  --work-id "widget-123" \
  --work-source github \
  --work-url "https://github.com/acme/widget/issues/123" \
  --work-title "Add saved filters"
```

Bind on launch when the task names a tracker issue or ticket. Use a repo-scoped
`--work-id` (not a provider-prefixed composite such as `github:owner/repo#123`);
pass the provider in `--work-source` and the canonical link in `--work-url`. Skip
binding for ad-hoc work with no tracker identity.

Every fresh launch creates an immutable attempt ID. Runs and telemetry inherit the
work and attempt correlation. Full verification produces exact-tree proof, and
`har env complete 1` records the completed outcome before teardown.

```text
External issue → Work unit → Attempt → Slot/worktree → Runs → Exact-tree validation
```

Factory derives active, failed, and verified state from that evidence. It stores
explicit state only for business outcomes such as completed or abandoned. A plain
teardown is operational cleanup and never claims success.

Historical repositories remain compatible: runs, validations, and slots without
work metadata continue to appear under Operations and repository detail. They are
not guessed into work units.

## Operations: runtime and infrastructure

The repository overview summarizes registered projects, total runs, active slots,
and harness profiles. Repository detail provides:

- active slots, worktrees, branches, preview URLs, dirtiness, and drift;
- a run timeline with stage, trigger, duration, and status;
- expected validation stages and their latest results;
- exact-tree change batches and associated commits;
- files under `.har/artifacts/`;
- verification trends and pass rates.

The global **Operations** page (`/worktrees`) lists session worktrees across
repositories (active and idle), with an **On disk** indicator, row selection,
select-all, and **Delete selected** to remove worktree directories and clear the
matching Mission Control slot rows (repository registration is kept). It also
highlights dirty/missing paths and shows **token and cost** columns when agent
telemetry is enabled (see below). Click a row for the slot leaf (LLM usage +
Verify pipeline + session timeline). Packaged Docker Mission Control may not see
host paths — use `har env teardown <id>` on the host when deletion fails. The
repository catalog lives at `/repos`; cross-repo usage rollup at `/usage`.

## Agent usage telemetry (Cursor / Claude / Codex)

HAR attributes Cursor, Claude Code, and Codex activity to each worktree/session via
[`@osfactory/otel-hook`](https://www.npmjs.com/package/@osfactory/otel-hook) and shows it in
Mission Control. Preference shape:

```json
{ "enabled": true, "signals": { "metrics": true, "logs": true, "prompts": true, "traces": true } }
```

**Default: full telemetry on** (traces + logs + derived metrics + prompts). Install
(`npm install -g @osfactory/har`) and the first `har` / MCP invocation persist this
preference to `~/.har/telemetry.json` when the file is missing. Prompt text also fills
the Mission Control **purpose** column from the first captured user prompt.

```bash
har telemetry status
har telemetry on              # full telemetry + Mission Control + @osfactory/otel-hook
har telemetry on --no-prompts # keep traces/logs/metrics; disable prompt text capture
har telemetry install-hooks   # re-run Cursor / Claude / Codex hook registration
har telemetry off             # clear hooks OTLP export + stop MC auto-start; keeps historical rows
```

Preference is stored in `~/.har/telemetry.json`. Override with `HAR_TELEMETRY=0|1`.
Hooks config lives at `~/.har/otel-hooks/otel_config.json` (`HAR_OTEL_HOOKS_HOME` to override).
The package itself is installed under `~/.har/otel-hooks/node_modules` (pinned
`@osfactory/otel-hook`).

### Upgrading from the Python hook

Run `har telemetry install-hooks` after upgrading HAR. HAR installs the TypeScript
package in its managed hooks directory, replaces existing HAR hook registrations,
and then removes the legacy `opentelemetry-hooks` tool when it was installed with
`uv` or `pipx`. The command name remains `otel-hook`, but HAR registrations use
`~/.har/otel-hooks/run-otel-hook.sh`; the old Python executable does not need to
remain on `PATH`. Python is no longer required for HAR telemetry.

For a standalone, user-wide `otel-hook` command outside HAR, install it separately
with `npm install -g @osfactory/otel-hook`.

When telemetry is on:

1. `har env launch` auto-starts Mission Control if it is not reachable (`har control up`).
2. `har telemetry on` (and launch) install `@osfactory/otel-hook` and register Cursor / Claude / Codex hooks
   to export OTLP `http/protobuf` to `{HAR_CONTROL_API_URL}/api/otel`.
3. Launch writes session attribution into `.env.agent.<id>` (`HAR_SESSION_KEY`, resource attrs).
   Mission Control matches sessions by `har.session_key` or by workspace/cwd → slot work dir.
4. Token usage is derived from span `gen_ai.usage.*` attributes. `har control sync` also
   **harvests** local Claude/Codex session files as a fallback when hooks telemetry is missing.

**Privacy:** prompt text is included by default and stays in local Mission Control (SQLite).
Opt out with `har telemetry on --no-prompts` or disable everything with `har telemetry off`.

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
