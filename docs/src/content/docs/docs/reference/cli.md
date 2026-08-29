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
            [--plugins playwright,rocketsim,kerno,gitleaks,trivy,semgrep|--no-plugins]
            [--agent-slots <n>]
            [--force]
            [--agents claude,cursor,codex] [--no-agents]
            [--cursor-rule|--no-cursor-rule]
            [--commit-gate prompt|always|never]
            [--gate-mode block|warn] [--gate-scope worktrees|all]
```

Onboarding probes Docker first (`docker --version` + `docker info`). Docker is
required — Mission Control runs as a container and harness infra uses Docker
Compose — so a missing CLI or stopped daemon is warned about, reported in the
summary, and Mission Control is not started by default until Docker works.

`--yes` accepts defaults (telemetry on, start Mission Control when Docker is
available, no plugins) without prompts. This is the first-run command for a
new repository — do not substitute `har env init` in user-facing copy.

`--agent-slots <n>` sets how many agents may run in parallel (`1`–`10`), written to
`.har/stages.json` as `agentSlots.max`. Interactive onboarding asks this when the
flag is omitted (practical limit depends on machine resources and stack cost).
With `--yes` and no `--agent-slots`, the profile template default is kept.

## `har env`

| Command | Purpose |
| --- | --- |
| `init` | Mechanical scaffold of `.har/` (fixtures / `--force`). Humans use `har onboard`. |
| `maintain` | Validate, compare templates, and prepare or finalize an upgrade |
| `add-plugin [plugin]` | Install a plugin (bundled id, path, npm, or git — registers stages) |
| `add-stage [id]` | Deprecated plugin alias for `add-plugin` (`--custom` removed in 1.0 — see `har plugin create`) |
| `preflight <id>` | Check ports, processes, Docker, slot occupation, and untracked worktree paths |
| `setup-infra` | Set up shared infrastructure (Docker services, template DB, or the iOS toolchain) |
| `launch <id>` | Start a fresh session (new worktree from `--repo` HEAD) |
| `recover <id>` | Resume a failed or partial launch |
| `verify <id>` | Run quick or full verification |
| `complete <id>` | Full verify, record validation, teardown, keep branch |
| `teardown <id>` | Free a slot without a completion validation; keep branch |
| `doctor` | Validate the harness contract (schema, stages, scripts, port lanes) |
| `eject` | Vendor the runtime into `.har/runtime/` and own the scripts yourself |
| `adopt` | Return an ejected harness to managed shims |
| `status` | Inspect all slots |
| `logs <id> [service]` | Show recent logs for a slot (optionally one service) |
| `agent <id> <command>` | Per-slot ops: `status`, `logs`, `restart`, `psql`, `health`, `url`, `reset-db`, `slow-queries`, `exec`, `attach` |
| `run-stage <id> <stage> [args..]` | Run one registered harness stage by id |
| `artifacts` | List result files under `.har/artifacts/` |
| `cleanup` | Discover stale sessions and orphan worktrees across registered repos |
| `runs list` | List persisted run records |
| `runs get <runId>` | Return one run record |

### Initialization

First-time humans should run `har onboard`. `har env init` is the mechanical
scaffold (same `initHarness` core as onboard and `har_init_harness`) — use it
for fixtures and `--force` wipes, not as the advertised first-run command.

```bash
har env init [--profile default|cli|ios] [--yes]
             [--smoke] [--force] [--verbose]
             [--agents claude,cursor,codex] [--no-agents]
             [--cursor-rule|--no-cursor-rule]
             [--commit-gate prompt|always|never]
             [--gate-mode block|warn] [--gate-scope worktrees|all]
```

`--force` replaces an existing harness and is destructive.

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
har env add-plugin playwright [--force] [--with-ci]
har env add-plugin rocketsim [--force]
har env add-plugin kerno [--force] [--with-ci]
har env add-plugin gitleaks [--force] [--with-ci]
har env add-plugin trivy [--force] [--with-ci]
har env add-plugin semgrep [--force] [--with-ci]
har env add-plugin ./my-plugin [--force]
har env add-plugin @org/har-cypress [--force]
har env add-plugin github:org/har-plugin [--force]
har plugin create <id> [--kind <kind>] [--description <text>]
                       [--package-fragment] [--force]
har plugin list
```

`add-plugin` installs a framework bundle that registers one or more stages
(bundled id, local plugin id, path, npm package, or git URL). Installs are
recorded in `.har/plugins.json` with their source kind. Bundled plugins are
discovered from disk — no core enum edit is required to ship a new id.
`har plugin create` scaffolds a project-owned plugin at `.har/plugins/<id>/`
(manifest, contract-compliant stage script, README); implement its TODO, then
install it with `add-plugin <id>`. `har env add-stage playwright` remains as a
deprecated alias of `add-plugin playwright`; `add-stage --custom` was removed
in 1.0 — one-liner checks are plain command stages in `.har/stages.json`. See
`.har/STAGES.md` in every generated harness and the [Plugins](/docs/guides/plugins/)
guide.

### Launch and recovery

```bash
har env preflight 1 [--json]
har env launch 1 [--no-worktree] [--claude] [--resume]
  [--work-id <id>] [--work-source <name>] [--work-url <url>]
  [--work-title <title>] [--parent-work-id <id>]
  [--work-link <source|url|label> ...]
har env recover 1
har env work-link --work-id <id> [--link <source|url|label>]
  [--source <name> --url <url> [--label <text>]]
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
`--work-url`, and `--work-title` when known. Add secondary links with repeatable
`--work-link source|url|label`, or later with `har env work-link`. A fresh bound
launch creates an immutable attempt UUID; `--resume` preserves the failed session's attempt.

A worktree only materializes what is in `HEAD`. Preflight and launch warn when
untracked (not gitignored) paths will be missing from the session worktree —
the count plus a few examples. Track them, or launch with `--no-worktree`. The
check is skipped when `HARNESS_USE_WORKTREE=false` and for a `--no-worktree`
launch. The same warning appears in `har env status --json`, MCP launch
`stderr`, and `./.har/launch.sh`.

### Verify and finish

```bash
har env verify 1 [--full] [--json]
har env complete 1 [--skip-verify]
har env teardown 1 [--delete-branch]
```

Default verify output is the live progress lines on stderr (and a one-line
summary). It does **not** reprint the machine JSON contract — that blob
duplicates step logs already shown. Use `--json` when a script needs the
structured result. Passing steps omit `output`; failed steps keep a truncated
excerpt. MCP `har_run_verification` returns the same slim shape.

### Doctor

```bash
har env doctor [--json]
```

`doctor` validates the harness contract and exits `0` on pass, `1` on errors
(so it slots into CI): `harness.env` against the schema, `stages.json` against
the registry schema, every registered stage's script/command file exists and is
executable, the lifecycle stages (launch/verify/teardown) resolve,
`verificationStages` ids resolve to registered stages, infra port lanes are
coherent (no overlaps, defaults inside scan ranges), and slot registry entries
point at existing worktrees. Every finding carries a remedy. Doctor also runs
automatically inside `har env maintain` and before every `launch` — a broken
adaptation blocks the launch instead of failing mid-session. Pre-1.0 harnesses
report contract findings as warnings until they migrate. On an ejected
harness, doctor additionally checks the vendored runtime exists and the
user-owned scripts are executable. MCP twin: `har_doctor`.

### Eject and adopt

```bash
har env eject [--yes]
har env adopt
```

`eject` is the explicit, supported path for power users who want to own the
runtime scripts: it vendors the complete HAR runtime bundle into
`.har/runtime/` and rewrites the `.har/*.sh` scripts to execute it directly
with node — no `har` on PATH, no npx fallback. The choice is recorded in
`.har/manifest.json` (`ejected`, `ejectedVersion`). From then on those files
are user-owned: `maintain` reports no upstream drift for them, and upstream
fixes reach them only by re-ejecting. Support covers issues reproducible with
the managed shims; changes made to an ejected runtime are yours to maintain.
Config surface files (`harness.env`, `stages.json`, `stages/`, docs) stay
managed either way.

`adopt` reverses it: regenerates the managed shims, removes `.har/runtime/`,
and clears the manifest record, preserving the config surface. Both commands
are deliberately CLI-only (no MCP twin) — runtime ownership is a human policy
decision with an interactive confirmation (`--yes` for automation).

### Status and runs

```bash
har env status [--json]
har env logs 1 [service]
har env run-stage 1 <stage> [args..] [--json]
har env artifacts [--stage <id>] [--json]
har env cleanup [--dry-run] [--yes] [--repo <path>]
                [--keep repo:agentId,/path/to/worktree]
                [--stale 7] [--orphans] [--include-review] [--json]
har env runs list [--stage <id>] [--limit 50] [--json]
har env runs get <uuid> [--json]
```

`status` has one implementation on every surface: the structured collector
behind `--json` is the source, the text view is rendered on top, and MCP
`har_get_status` returns the same object. Status is a pure read — it writes no
run records. `run-stage` executes any stage registered in `.har/stages.json`
(the CLI twin of MCP `har_run_stage`); `artifacts` is the twin of
`har_list_artifacts`.

`cleanup` scans every repo in `~/.har/repos.json` (plus `--repo` when set),
classifies active slots and orphan directories under `~/worktrees`, and runs
full harness teardown for approved rows. Use `--dry-run` to preview the plan;
pin live sessions with `--keep har-portal:4` or a worktree path.

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

## `har hq`

```bash
har hq connect [--portal <url>] [--api-key <key>] [--repo .] [--yes] [--json]
har hq list [--json]
har hq disconnect [name] [--yes] [--json]
```

Connect this checkout to a HAR HQ workspace. On a TTY, `connect` asks Production
(`https://app.harhq.com`), Development (`https://app.dev.harhq.com`), or a custom
URL, then opens browser SSO. The workspace chosen on the consent screen is the
destination; HAR attaches **this repository** to that workspace. When other
repositories are already registered locally, the consent page (or a TTY fallback)
shows their count and paths. You can send all of them to one workspace, or pick
a workspace and then the repositories for it — already-assigned paths are hidden
on the next workspace. `--yes` / `--json` skip that prompt and attach only the
current checkout. A second `har hq connect` from another checkout (or against
another workspace) adds another attachment — it does not replace the first
connection.

Automatic sync sends only to workspaces a repository is **attached** to. A
single leftover connection is not inherited by unattached checkouts.

`list` shows saved connections (workspace + portal host, never tokens).
`disconnect` removes one connection and its credentials. Credentials stay in
`~/.har/` and are never committed into `.har/`.

`har control login` remains a deprecated alias for `har hq connect`.

## `har control`

```bash
har control up [--build] [-d|--detach|--no-detach]
har control down
har control register [--repo .] [--api-url <url>] [--dry-run] [--force] [--portal|--no-portal]
har control unregister [--repo .] [--api-url <url>] [--yes] [--delete-worktrees] [--dry-run] [--json]
har control reset [--yes] [--no-scrub-local] [--keep-registry] [--api-url <url>] [--dry-run] [--json]
har control sync [--select] [--api-url <url>] [--dry-run] [--json] [--cloud] [--full] [--target <alias>] [--targets a,b]
har control watch [--repo .] [--interval 10] [--api-url <url>]
har control login [--portal <url>] [--api-key <key>] [--repo .]
har control trajectory [on|off] [--target <alias>]
```

`login` is a deprecated alias for `har hq connect`. Prefer `har hq connect`.
`sync --select` interactively chooses repositories; `--full` ignores the portal
watermark and resends the complete payload. `--target` / `--targets` send to named
saved connections for a one-off push; automatic activity-edge sync uses the
workspace(s) this repository was attached to at `har hq connect`.
`register --no-portal` keeps the repo on local Mission Control only (skips hosted
portal sync even when logged in); `--portal` re-enables portal sync for that repo.

`trajectory` controls whether sync forwards the trajectory ledger — agent prompts,
tool arguments and tool results — to a hosted portal. Off by default: without it a
portal receives runs, slots, token counts and events, and those bodies stay on this
machine. Use `--target` to scope the setting to one saved portal destination; the
preference is stored per target in `~/.har/portal-targets.json`. Requires telemetry
to be on, and `HAR_PORTAL_TRAJECTORY=on|off` overrides the stored choice. Forwarded
content is capped and redacted by the same local policy that governs storage (see
the Mission Control guide).

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
