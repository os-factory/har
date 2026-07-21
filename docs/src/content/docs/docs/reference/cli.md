---
title: CLI reference
description: Commands and important options exposed by the HAR executable.
---

All repository commands accept `--repo <path>`; the default is the current directory.

## `har env`

| Command | Purpose |
| --- | --- |
| `init` | Scaffold and adapt a new `.har/` |
| `maintain` | Validate, compare templates, and prepare or finalize an upgrade |
| `add-stage [template]` | List/install shipped templates or register a custom stage |
| `preflight <id>` | Check ports, processes, Docker, and slot occupation |
| `launch <id>` | Create and start a fresh slot session |
| `recover <id>` | Resume a failed or partial launch |
| `verify <id>` | Run quick or full verification |
| `complete <id>` | Full verify, record validation, teardown, keep branch |
| `teardown <id>` | Stop a slot and keep its branch |
| `status` | Inspect all slots |
| `runs list` | List persisted run records |
| `runs get <runId>` | Return one run record |

### Initialization

```bash
har env init [--profile default|cli|ios] [--auto] [--yes]
             [--smoke] [--force] [--model <claude-model>]
             [--agents claude,cursor,codex] [--no-agents]
             [--cursor-rule|--no-cursor-rule]
```

`--auto` requires `ANTHROPIC_API_KEY`. `--force` replaces an existing harness and
is destructive.

### Maintenance

```bash
har env maintain [--auto] [--yes] [--finalize]
                 [--summary <text>] [--agents <targets>]
                 [--cursor-rule|--no-cursor-rule]
```

### Stages

```bash
har env add-stage --list
har env add-stage playwright [--force] [--skip-ci]
har env add-stage rocketsim [--force]
har env add-stage <id> --custom --kind <kind>
                       [--command <shell-command>|--script]
                       [--description <text>] [--verification] [--force]
```

`--command` registers a direct command. `--script` scaffolds a contract-compliant
`.har/stages/<id>.sh`; implement its TODO before verification can pass. See
`.har/STAGES.md` in every generated harness.

### Launch and recovery

```bash
har env preflight 1 [--json] [--replace] [--force]
har env launch 1 [--no-worktree] [--claude] [--replace] [--force] [--resume]
har env recover 1
```

`--replace` confirms replacement of an occupied slot. `--force` additionally
permits discarding dirty uncommitted work and must only follow explicit approval.

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

## `har hooks`

```bash
har hooks install [--force]
har hooks uninstall
har hooks status [--json]

har hooks install --claude
har hooks uninstall --claude
```

The default installs the Git commit gate. `--claude` selects the Claude Code
main-checkout edit guard instead. `check` and `record-commit` are hook workers.

## `har control`

```bash
har control up [--build] [--no-detach]
har control down
har control register [--api-url <url>] [--dry-run]
har control sync [--api-url <url>] [--dry-run] [--json] [--cloud]
har control watch [--interval 10] [--api-url <url>]
har control login --api-key <key>
```

## `har telemetry`

```bash
har telemetry status [--json]
har telemetry on
har telemetry off
har telemetry write-env --agent-id <n> [--repo .] [--env-file path]
har telemetry print-env --agent-id <n>
har telemetry codex-snippet --agent-id <n> [--write]
```

Controls agent usage telemetry (Claude Code / Codex → Mission Control). **Default: on.**
`on` ensures Mission Control is running. Preference: `~/.har/telemetry.json` (override
with `HAR_TELEMETRY=0|1`).

## `har mcp`

```bash
har mcp [--repo /default/repository]
```

Starts a stdio MCP server. Logs go to stderr so stdout remains valid protocol traffic.
