---
title: CLI reference
description: Commands and important options exposed by the HAR executable.
---

All repository commands accept `--repo <path>`; the default is the current directory.

## `har onboard`

Interactive first-run guide: how HAR works, telemetry, Mission Control, plugins,
parallel agent slot capacity, then the adaptation prompt (clipboard +
`.har/ADAPT-PROMPT.md`).

```bash
har onboard [--repo .] [--yes] [--skip-guide] [--skip-init]
            [--profile default|cli|ios]
            [--telemetry on|on-no-prompts|off]
            [--control|--no-control]
            [--plugins playwright,rocketsim|--no-plugins]
            [--agent-slots <n>]
            [--force]
            [--agents claude,cursor,codex] [--no-agents]
            [--cursor-rule|--no-cursor-rule]
            [--commit-gate prompt|always|never]
            [--gate-mode block|warn] [--gate-scope worktrees|all]
```

`--yes` accepts defaults (telemetry on, start Mission Control, no plugins) without
prompts. Prefer this over hand-rolling `preferences` + `env init` + `telemetry`
+ `control up` for new repositories.

`--agent-slots <n>` sets how many agents may run in parallel (`1`–`10`), written to
`.har/stages.json` as `agentSlots.max`. Interactive onboarding asks this when the
flag is omitted (practical limit depends on machine resources and stack cost).
With `--yes` and no `--agent-slots`, the profile template default is kept.

## `har env`

| Command | Purpose |
| --- | --- |
| `init` | Scaffold and adapt a new `.har/` |
| `maintain` | Validate, compare templates, and prepare or finalize an upgrade |
| `add-plugin [plugin]` | Install a shipped plugin (registers stages) |
| `add-stage [id]` | Register a custom stage (`--custom`), or deprecated plugin alias |
| `preflight <id>` | Check ports, processes, Docker, and slot occupation |
| `launch <id>` | Start a fresh session (new worktree from `--repo` HEAD) |
| `recover <id>` | Resume a failed or partial launch |
| `verify <id>` | Run quick or full verification |
| `complete <id>` | Full verify, record validation, teardown, keep branch |
| `teardown <id>` | Free a slot without a completion validation; keep branch |
| `status` | Inspect all slots |
| `runs list` | List persisted run records |
| `runs get <runId>` | Return one run record |

### Initialization

```bash
har env init [--profile default|cli|ios] [--yes]
             [--smoke] [--force] [--verbose]
             [--introspect|--no-introspect]
             [--agents claude,cursor,codex] [--no-agents]
             [--cursor-rule|--no-cursor-rule]
             [--commit-gate prompt|always|never]
             [--gate-mode block|warn] [--gate-scope worktrees|all]
```

`--force` replaces an existing harness and is destructive.

`--no-introspect` skips reading the Xcode project on the `ios` profile and leaves the
scaffold placeholders in place. Introspection is on by default and never fails init —
whatever it cannot resolve is printed as a warning to act on.

### Maintenance

```bash
har env maintain [--yes] [--finalize]
                 [--summary <text>] [--agents <targets>] [--verbose]
                 [--cursor-rule|--no-cursor-rule]
                 [--commit-gate prompt|always|never]
                 [--gate-mode block|warn] [--gate-scope worktrees|all]
```

### Plugins and stages

```bash
har env add-plugin --list
har env add-plugin playwright [--force] [--skip-ci]
har env add-plugin rocketsim [--force]
har env add-stage <id> --custom --kind <kind>
                       [--command <shell-command>|--script]
                       [--description <text>] [--verification] [--force]
```

`add-plugin` installs a framework bundle that registers one or more stages.
`add-stage --custom` registers a project-specific stage. `har env add-stage
playwright` remains as a deprecated alias of `add-plugin playwright`.

`--command` registers a direct command. `--script` scaffolds a contract-compliant
`.har/stages/<id>.sh`; implement its TODO before verification can pass. See
`.har/STAGES.md` in every generated harness and the [Plugins](/docs/guides/plugins/)
guide.

### Launch and recovery

```bash
har env preflight 1 [--json]
har env launch 1 [--no-worktree] [--claude] [--resume]
  [--work-id <id>] [--work-source <name>] [--work-url <url>]
  [--work-title <title>] [--parent-work-id <id>]
har env recover 1
```

Every `launch` creates a **new** session from the current HEAD of `--repo` (the
main checkout). Occupied slots always block a new launch — the error message
prints the upcoming base so you can confirm it before freeing the slot.

An occupied slot must be freed before relaunching: `har env complete 1` (or
`teardown 1`), then `har env launch 1`. Launch never chooses `main` for you.
If the worktree has uncommitted changes, commit or discard them in the
worktree first. Use `--resume` / `recover` only for a failed or starting
launch — it is not a way to replace an active session.

Work metadata is optional and backward compatible. Bind when the task names a
tracker issue or ticket: pass a short repo-scoped `--work-id`, plus `--work-source`,
`--work-url`, and `--work-title` when known. A fresh bound launch creates an
immutable attempt UUID; `--resume` preserves the failed session's attempt.

### Verify and finish

```bash
har env verify 1 [--full]
har env complete 1 [--skip-verify]
har env teardown 1 [--delete-branch]
```

### Status and runs

```bash
har env status [--json]
har env runs list [--stage <id>] [--limit 50] [--json]
har env runs get <uuid> [--json]
```

## `har agents`

```bash
har agents install [--claude] [--cursor] [--codex]
                   [--agents <targets>] [--force]
har agents remove [--claude] [--cursor] [--codex]
```

Without target flags, HAR detects supported agent directories.

## `har preferences`

```bash
har preferences show [--json]
har preferences configure
har preferences configure --cursor-rule <auto|on|off>
  --agents <auto|none|claude,cursor,codex>
  --commit-gate <prompt|always|never>
  --gate-mode <block|warn>
  --gate-scope <worktrees|all>
```

Preferences are user-level defaults stored in `~/.har/preferences.json`.
Repository policy remains visible and versioned in `.har/stages.json`.

## `har hooks`

```bash
har hooks install [--repo .] [--force]
har hooks uninstall [--repo .]
har hooks status [--repo .] [--json]

har hooks install --claude
har hooks uninstall --claude
```

The default installs the Git commit gate. `--claude` selects the Claude Code
main-checkout edit guard instead. `har hooks check` and `har hooks record-commit`
are internal hook workers invoked by Git, not day-to-day commands.

## `har control`

```bash
har control up [--build] [-d|--detach|--no-detach]
har control down
har control register [--repo .] [--api-url <url>] [--dry-run] [--force]
har control unregister [--repo .] [--api-url <url>] [--yes] [--delete-worktrees] [--dry-run] [--json]
har control reset [--yes] [--no-scrub-local] [--keep-registry] [--api-url <url>] [--dry-run] [--json]
har control sync [--select] [--api-url <url>] [--dry-run] [--json] [--cloud] [--full]
har control watch [--repo .] [--interval 10] [--api-url <url>]
har control login [--portal <url>] [--api-key <key>]
```

`login` resolves the portal from `--portal`, then `HAR_PORTAL_URL`, then the
portal of your last login, and finally `https://har.kerno.io`; it prints which
one it picked. With `--api-key` it stores that ingest token; without it, HAR
opens browser SSO and saves the resulting token.
`sync --select` interactively chooses repositories; `--full` ignores the portal
watermark and resends the complete payload.

`unregister` removes the repository from Mission Control and `~/.har/repos.json`.
Interactively it lists session worktrees and asks whether to delete them; pass
`--delete-worktrees` (with `--yes` in non-TTY) to remove worktrees via harness
teardown. Re-add later with `har control register`.

`reset` clears **all** Mission Control data (every repository and cascaded
rows), clears the unregister blocklist, scrubs local
`.har/{runs,validations,state,slots}` under registered repos (default), and
clears `~/.har/repos.json` so the next register starts clean. Use
`--no-scrub-local` / `--keep-registry` to keep those. The same action is
available in the dashboard under **Settings → Danger zone**.

## `har telemetry`

```bash
har telemetry status [--json]
har telemetry on [--prompts|--no-prompts]
har telemetry off
har telemetry install-hooks
har telemetry write-env --agent-id <n> [--repo .] [--env-file path]
                       [--work-dir path] [--branch name] [--suffix id] [--session-key key]
har telemetry print-env --agent-id <n> [--repo .]
                       [--work-dir path] [--branch name] [--suffix id]
```

Controls agent usage telemetry (Cursor / Claude / Codex via `@osfactory/otel-hook` → Mission Control).
**Default: full on** (traces, logs, metrics, prompts). Install and the first `har` invocation
persist `~/.har/telemetry.json` when missing. `on` ensures Mission Control is running and
installs/configures hooks. Use `--no-prompts` to keep telemetry without prompt text.
Override with `HAR_TELEMETRY=0|1`. Hooks config: `~/.har/otel-hooks/otel_config.json`.

## `har mcp`

```bash
har mcp [--repo /default/repository]
```

Starts a stdio MCP server. Logs go to stderr so stdout remains valid protocol traffic.
