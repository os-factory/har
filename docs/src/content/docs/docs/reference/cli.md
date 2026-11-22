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
            [--telemetry full|outline|usage|off] [--hq-trajectory|--no-hq-trajectory]
            [--control|--no-control]
            [--plugins playwright,cypress,rocketsim,kerno,gitleaks,trivy,semgrep|--no-plugins]
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

`--yes` accepts defaults (the telemetry level already chosen on this machine, else
`full`; start Mission Control when Docker is available; no plugins) without prompts.

Onboarding asks **how much agent activity to record** — the same four levels as
[`har telemetry`](#har-telemetry) — and, when connected to HAR HQ at the `full` level,
whether HQ also receives the full trajectory (`--hq-trajectory`; off by default). The
level is machine-wide: it applies to every repository on this machine. The older
`--telemetry on` / `on-no-prompts` still work and mean `full` / `outline`. This is the first-run command for a
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
| `complete <id>` | Reuse last matching full validation, teardown, keep branch (`--verify` to re-run) |
| `teardown <id>` | Free a slot without a completion validation; keep branch |
| `doctor` | Validate the harness contract (schema, stages, scripts, port lanes, env.template) |
| `eject` | Vendor the runtime into `.har/runtime/` for offline ownership |
| `adopt` | Return an ejected harness to the packaged runtime |
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
har env add-plugin cypress [--force] [--with-ci]
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

A **factory line** is the other bundle kind: it registers stages but never adds
them to `verificationStages`. `add-plugin` refuses a line bundle and points at
`har line add` — see [`har line`](#har-line).

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
har env work-bind [<id>] --work-id <id> [--work-title <title>] [--work-url <url>]
  [--work-source <name>] [--parent-work-id <id>] [--work-link <source|url|label> ...] [--json]
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

When the work id is only known after launch (a slot started from a panel, an
agent that learns the ticket by reading the task), bind it to the running slot
with `har env work-bind`. Without `<id>` it binds the slot whose work dir
contains the current directory, so an agent can run it from its worktree:

```bash
har env work-bind --work-id FE-2071 --work-title "Bind work after launch" \
  --work-url https://linear.app/acme/issue/FE-2071
```

A binding always mints a new attempt and writes it to the slot (`har env
status` shows the unit). A first binding's attempt covers the slot since its
launch. Rebinding to another unit starts a new attempt from now: the previous
unit keeps its attempt, run records, validations and usage, and is closed as
`abandoned`. Binding the unit the slot already carries only merges metadata.
A unit already bound to another slot is refused. The `.env.agent.<id>`
attribution is rewritten for processes started afterwards; agents already
running are attributed through the slot record.

A worktree only materializes what is in `HEAD`. Preflight and launch warn when
untracked (not gitignored) paths will be missing from the session worktree —
the count plus a few examples. Track them, or launch with `--no-worktree`. The
check is skipped when worktrees are off (see [`har worktree`](#har-worktree)) and
for a `--no-worktree` launch. The same warning appears in `har env status --json`, MCP launch
`stderr`, and `har env launch`.

### Verify and finish

```bash
har env verify 1 [--full] [--json]
har env complete 1 [--verify]
har env teardown 1 [--delete-branch]
```

`complete` reuses the last passing full validation for the current tree. Pass
`--verify` to re-run full verification if the worktree may have changed.
`--skip-verify` is a deprecated no-op (skip is the default).

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
(so it slots into CI): the running CLI is not older than `manifest.cliVersion`,
`harness.env` against the schema, `stages.json` against
the registry schema, every registered stage's script/command file exists and is
executable, the lifecycle stages (launch/verify/teardown) resolve,
`verificationStages` ids resolve to registered stages, infra port lanes are
coherent (no overlaps, defaults inside scan ranges), `env.template` only
references variables launch substitutes, as plain `$VAR` / `${VAR}` (anything
else — including `${VAR:-default}` and other shell parameter syntax — is written
literally to `.env.agent.<id>`, reported as a warning), and slot registry entries point at
existing worktrees. Every finding carries a remedy. Doctor also runs
automatically inside `har env maintain` and before every `launch` — a broken
adaptation blocks the launch instead of failing mid-session. A stale CLI vs a
newer harness is a single upgrade error, not a list of missing lifecycle
scripts. Pre-1.0 harnesses
report contract findings as warnings until they migrate. On an ejected
harness, doctor additionally checks the vendored runtime exists and the
user-owned scripts are executable. MCP twin: `har_doctor`.

### Eject and adopt

```bash
har env eject [--yes]
har env adopt
```

`eject` is the explicit, supported path for power users who want to own the
runtime: it vendors the complete HAR runtime bundle into `.har/runtime/` —
no `har` on PATH, no npx fallback. Invoke it as
`node .har/runtime/har.cjs env …`. The choice is recorded in
`.har/manifest.json` (`ejected`, `ejectedVersion`). From then on the vendored
runtime is user-owned: `maintain` reports no upstream drift for it, and
upstream fixes reach it only by re-ejecting. Support covers issues
reproducible with the packaged runtime; changes made to an ejected runtime
are yours to maintain. Config surface files (`harness.env`, `stages.json`,
`stages/`, docs) stay managed either way.

`adopt` reverses it: removes `.har/runtime/` and clears the manifest record,
preserving the config surface. Both commands are deliberately CLI-only (no
MCP twin) — runtime ownership is a human policy decision with an interactive
confirmation (`--yes` for automation).

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

## `har line`

```bash
har line create <id> [--stations S1,S2,S3] [--title <text>]
                     [--description <text>] [--opt-in-env <VAR>]
                     [--no-gate-stage] [--force]
har line add <id|./path|@org/pkg|github:org/repo> [--force]
har line status [id] [--json]
har line gate <station> [--line <id>] [--agent <slot>] [--force] [--json]
har line list
```

A **factory line** is a program: an ordered set of stations plus a cumulative
gate. It composes what HAR already has — work units, slots, stages, plugins,
skills, MCP — and is installed through the same channels as a plugin (path →
git → bundled id → npm).

The difference is the apply path. Installing a line registers its stages in
`.har/stages.json` and records the install in `.har/lines.json`, but **never**
touches `verificationStages`. Default `har env verify --full` takes exactly as
long as it did before. Line gate stages run on demand:

```bash
har line gate S2 --line my-line
```

`gate.stages[].fromStation` is the ratchet: a stage tagged at a station is
required at that station **and every later one**, so growing a line can never
drop an earlier station's checks.

`har line create` scaffolds a publishable bundle at `.har/lines/<id>/`
(`line.manifest.json`, `line.json`, an off-verify gate stage, README);
`har line add <id>` installs it. Publishing to git or npm later needs no format
change.

Poka-yoke runs both ways: `har env add-plugin` refuses a line bundle, and
`har line add` refuses a verification-plugin manifest. If a check should gate
*every* verify, it is a plugin, not a line. `har env doctor` fails if a line
stage ever appears in `verificationStages`.

See the [Factory lines](/docs/guides/factory-lines/) guide.

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
are internal hook workers invoked by Git, not day-to-day commands. So is
`har hooks commit-msg <file>`, which is installed only when `.har/harness.env`
sets `HAR_FACTORY_PROOF=notes+trailers`.

## `har proof`

```bash
har proof show [rev] [--repo .] [--json]
har proof verify [rev|A..B] [--min-level L0|L1|L2|L3] [--allowed-signers <file>] [--repo .] [--json]
```

Read-only wrappers around the `git-factory` executable (`HAR_FACTORY_PROOF_BIN`,
else `PATH`) for [Factory Commits](https://github.com/os-factory/factory-commits)
proofs. `--json` passes `git factory`'s JSON through. Otherwise HAR prints the
level and problems for each commit. Exit codes come from `git factory`: `0` ok,
`1` verification failed, `2` usage or environment error (including a missing
`git-factory`). See [Record Factory Commits proofs](/docs/guides/factory-commits/).

## `har hq`

```bash
har hq connect [--portal <url>] [--api-key <key>] [--repo .] [--trajectory|--no-trajectory] [--yes] [--json]
har hq list [--json]
har hq disconnect [--json]
```

The CLI holds **one HAR HQ org connection at a time**, and every sync, OTel and
trajectory upload goes to that org only. On a TTY, `connect` asks Production
(`https://portal.kerno.io/har`), Development (`https://portal.dev.kerno.io/har`), or a custom
URL, then opens browser SSO. The org chosen on the consent screen becomes the
connection, and HAR attaches **this repository** to it. When other repositories
are registered locally, a TTY prompt lists them so you can attach more to the
same org. `--yes` / `--json` skip that prompt and attach only the current checkout.

Running `connect` again for the same org adds the current checkout and keeps the
repositories already attached. Connecting to a **different** org replaces the
connection: the previous org's credentials are removed, nothing more is sent to
it, and its attached repositories stop syncing until you attach them to the new
org. A sync that is already running when you switch stops before sending
anything else to the previous org.

Automatic sync sends only repositories **attached** to the connection;
unattached checkouts are never ingested.

`list` shows the connection (org + portal host, never tokens) and its attached
repositories. `disconnect` removes the connection and its credentials.
Credentials stay in `~/.har/` and are never committed into `.har/`. A
`~/.har/portal-targets.json` written by an older CLI with several connections is
reduced to its default (else most recently used) connection the first time it is
read; the other connections and their tokens are deleted.

`har control login` remains a deprecated alias for `har hq connect`.

## `har control`

```bash
har control up [--build] [-d|--detach|--no-detach]
har control down
har control register [--repo .] [--api-url <url>] [--dry-run] [--force] [--portal|--no-portal]
har control unregister [--repo .] [--api-url <url>] [--yes] [--delete-worktrees] [--dry-run] [--json]
har control reset [--yes] [--no-scrub-local] [--keep-registry] [--api-url <url>] [--dry-run] [--json]
har control sync [--select] [--api-url <url>] [--dry-run] [--json] [--cloud] [--full]
har control check-usage [--repo <path|id>] [--api-url <url>] [--json] [--limit 20]
har control watch [--repo .] [--interval 10] [--api-url <url>]
har control login [--portal <url>] [--api-key <key>] [--repo .]
har control trajectory [on|off]
```

`login` is a deprecated alias for `har hq connect`. Prefer `har hq connect`.
`sync --select` interactively chooses repositories, saved in
`~/.har/sync-selection.json`; once saved, automatic syncs also touch only those
repositories. `register` adds its repository to a saved selection. `--full` ignores the portal watermark and resends the complete
payload. Portal sync always goes to the one
connected HAR HQ org; set `HAR_PORTAL_URL` and `HAR_PORTAL_TOKEN` to send a run to
a different org instead.
`check-usage` is read-only: Mission Control checks the usage invariants over
everything it holds and would sync (I1 a request is stored in one repository,
I2 a legacy session total is stored once, I3 a session's rows hold exactly its
requests, I4 a slot is not the main checkout, I5 Cursor cache reads are counted
once), listing each violation with its keys, tokens and cost. It exits 1 on a
violation. `sync` runs the same check and leaves the sessions breaking I1 or I2
(usage counted twice) out of the HQ post, names them with their cost, and
offers them again once fixed; the rest of the repository still goes.
`HAR_SYNC_ALLOW_USAGE_VIOLATIONS=1` posts everything.
`register --no-portal` keeps the repo on local Mission Control only (skips hosted
portal sync even when logged in); `--portal` re-enables portal sync for that repo.

`trajectory` controls whether sync forwards the trajectory ledger — agent prompts,
tool arguments and tool results — to a hosted portal. Off by default: without it a
portal receives runs, slots, token counts and events, and those bodies stay on this
machine. The setting belongs to the connected HAR HQ org and is stored with it in
`~/.har/portal-targets.json`; switching org starts with it off. Requires telemetry
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
har telemetry on [--level full|outline|usage]
har telemetry off
har telemetry install-hooks
har telemetry write-env --agent-id <n> [--repo .] [--env-file path]
                       [--work-dir path] [--branch name] [--suffix id] [--session-key key]
har telemetry print-env --agent-id <n> [--repo .]
                       [--work-dir path] [--branch name] [--suffix id]
har telemetry destination add <name> --preset langfuse [--host url] [--public-key pk] [--secret-key sk]
har telemetry destination add <name> --preset otlp --endpoint url [--header Name=value]…
                       [--signals traces,logs,metrics] [--protocol http/protobuf|http/json]
                       [--disabled] [--overwrite]
har telemetry destination list [--json]
har telemetry destination remove <name>
har telemetry destination test <name> [--json]
```

Controls how much agent activity (Cursor / Claude / Codex) is recorded in Mission Control.
One **level** is stored; each includes the ones below it:

| Level | Records |
|-------|---------|
| `full` (default) | Everything in `outline`, plus prompts, agent replies and tool inputs/outputs |
| `outline` | `usage`, plus one row per prompt, generation and tool call with timing — no text |
| `usage` | Tokens and cost per request (Claude Code native telemetry, Claude / Codex session files at sync). Cursor reports usage only through the hook, so it needs `outline` |
| `off` | Nothing |

`on` stores the level (replacing the previous one outright), ensures Mission Control is
running and rewrites the hook config; start a new agent session to pick it up. `--prompts`
/ `--no-prompts` remain as spellings of `full` / `outline`. `status` prints the level and
warns when `~/.har/otel-hooks/otel_config.json` records something else (for example a
preference edited by hand). Override with `HAR_TELEMETRY=<level>` or `HAR_TELEMETRY=0|1`.
HAR HQ receives the text only with `har control trajectory on`.

### Destinations (any OTLP backend)

`har telemetry destination` stores OTLP/HTTP backends that receive a copy of the
telemetry — an OpenTelemetry Collector, Langfuse, Datadog, … — in
`~/.har/destinations/telemetry.json` (mode `0600`: header values are secrets). Nothing
is configured by default, and nothing leaves the machine until you add one.

- `--preset langfuse` sends traces to `<host>/api/public/otel` with
  `Authorization: Basic base64(public:secret)`. Langfuse ingests OTLP traces only.
  The keys default to `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY`, the host to
  `LANGFUSE_BASE_URL`, `LANGFUSE_HOST` or `https://cloud.langfuse.com`.
- `--preset otlp` takes a base `--endpoint` (signals go to `<endpoint>/v1/<signal>`),
  any `--header Name=value`, and all three signals unless `--signals` narrows them.

`list` masks header values. `test` sends one small OTLP/JSON record to the destination
and reports the HTTP status. `har control up` mounts `~/.har/destinations` read-only
into the Mission Control container. Guides: [Langfuse](/docs/guides/langfuse/),
[any OTLP backend](/docs/guides/otlp-backends/).

**Verification spans.** Each `har env verify` (and MCP `har_run_verification`) sends
one OTel CI/CD trace straight from the CLI to every enabled destination subscribed to
`traces`: a run span (`cicd.pipeline.*`, `factory.run.id`, `factory.git.tree`,
`factory.verdict` on `--full`) with one child span per stage, plus the work unit,
attempt, repository and branch on the resource. The trace id is derived from the
validation id, so it sits next to the agent's session traces in the same backend.
Spans carry ids, results and timings only: no commands, logs or local paths. Delivery
is best-effort (about 3 s per destination, in parallel) and never changes verify's
result; a failed delivery prints one dim line. `har telemetry off` sends none.

## `har worktree`

```bash
har worktree status [--json] [--repo .]
har worktree off [--global] [--repo .]
har worktree on [--global] [--repo .]
har worktree reset [--global] [--repo .]
```

Your personal choice between launching slots in an isolated session worktree
(default) or in the checkout itself. `off` / `on` apply to the current
repository (keyed by its main checkout path), or to all repositories with
`--global`; `reset` clears that setting. Stored in `~/.har/preferences.json`.

A launch resolves the mode once, highest first:

1. `--worktree` / `--no-worktree`, or the MCP `worktree` parameter
2. `HAR_WORKTREE=on|off`
3. your setting for this repository
4. your setting for all repositories
5. `HARNESS_USE_WORKTREE` in `.har/harness.env` (the team default)
6. on

`har env launch`, `har env status`, `har env doctor` and `har worktree status`
print the effective mode and which of these decided it; `status --json` and the
MCP launch result carry it as `worktreeMode`. `har env recover` keeps the mode
the slot was launched with. There is no MCP tool for this setting.

## `har mcp`

```bash
har mcp [--repo /default/repository]
```

Starts a stdio MCP server. Logs go to stderr so stdout remains valid protocol traffic.
