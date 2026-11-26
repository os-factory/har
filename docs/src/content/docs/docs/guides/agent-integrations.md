---
title: Agent integrations
description: Install HAR workflows for Cursor, Claude Code, Codex, and MCP clients.
---

HAR's runtime is agent-agnostic. Integrations teach an agent when and how to use the
same repository-owned harness.

## Project instruction files

During `har onboard`, HAR detects existing entrypoints (`AGENTS.md`,
legacy `AGENT.md`, `CLAUDE.md`, `.cursor/`, `.claude/`, `~/.codex`), prints what it
found, and shows where HAR instructions will be installed after you confirm targets:

| File | Role |
| --- | --- |
| `AGENTS.md` | Canonical shared HAR workflow section (always created/updated — Codex and Claude Code auto-load this) |
| `CLAUDE.md` | Not managed by HAR — never created or edited (Claude Code reads `AGENTS.md` directly) |
| `.cursor/rules/har-workflow.mdc` | Always-on Cursor injection (when Cursor is confirmed) |
| Skills / prompts | `/setup-har`, `/har-wt`, `/har-maintain`, `/factory-line` for confirmed agents |

Legacy `AGENT.md` is migrated into `AGENTS.md` and removed. Existing project-owned
`AGENTS.md` content is preserved; HAR only upserts a marked HAR section.

## Managed workflows

HAR provides four workflows:

| Workflow | Purpose |
| --- | --- |
| `/setup-har` | Install HAR, choose a profile, initialize, adapt, prove, and commit a harness |
| `/har-wt` | Launch a slot, work only in its worktree, and verify the task |
| `/har-maintain` | inspect drift, apply maintenance updates, finalize, and re-verify |
| `/factory-line` | Run one station of a declared multi-station program (`*.line.json`) |

Targets are auto-detected during `init` and `maintain`, or selected explicitly:

```bash
har agents install --claude --cursor
har agents install --codex
har agents install --agents claude,cursor,codex
har agents remove --claude
```

Locations differ by agent:

- Claude Code: `.claude/skills/<name>/SKILL.md` in the repository;
- Cursor: `.cursor/commands/<name>.md` in the repository;
- Codex: `~/.codex/prompts/` globally, because Codex has no repository prompt folder.

Managed files carry a HAR header. `maintain` refreshes files that remain managed and
preserves files whose header was removed. `--force` explicitly overwrites modified
managed targets.

## Cursor rule

HAR can scaffold `.cursor/rules/har-workflow.mdc`, which injects launch-before-edit
and verify-before-done guidance into every Cursor agent session:

```bash
har env maintain --cursor-rule
har env maintain --no-cursor-rule
```

An existing rule is refreshed on maintain.

## Claude Code worktree guard

Optional enforcement blocks Claude Code edit tools in the main checkout:

```bash
har hooks install --claude
har hooks uninstall --claude
```

This writes a repository guard script and a `PreToolUse` entry in
`.claude/settings.json`. Edits inside HAR session worktrees pass. The
`HAR_SKIP_WT_GUARD=1` bypass is intended for deliberate human use.

## MCP

Agents scaffold a new harness with `har_init_harness` — not `har onboard`.

Any MCP client can discover HAR's generic tools for initialization, preflight,
launch, recovery, stages, verification, status, logs, completion, teardown,
artifacts, runs, and Mission Control.

MCP is the preferred interface in agents because it returns structured results
the model does not have to parse. Run history is identical on every surface —
`har env …` and MCP run the same packaged runtime and write the same records.

## External worktree managers

HAR also runs inside a checkout it did not create — a Conductor workspace, a
Cursor worktree, a cloud sandbox, or a hand-rolled `git worktree add`. Turn
HAR's own session worktrees off once, in the main checkout:

```bash
har worktree off
```

The setting is yours and is keyed by the main checkout, so every linked
worktree of the repository picks it up. Agents then call a plain
`har env launch <id>` / `har_launch_environment` in the orchestrator's
checkout; HAR records `mode: external` and will not delete the orchestrator's
tree on teardown. It also applies to launches from the main checkout itself,
which then run in place. `har worktree status` shows the effective mode, and
`har worktree reset` undoes it — see [`har worktree`](/docs/reference/cli/#har-worktree).

For a one-off, pass `--no-worktree` to a single launch instead.

The `.har/` contract has to live on the **branch / commit the orchestrator
branches from**. Many managers pin a base SHA when the repository is added and
ignore later local updates to `origin/HEAD`. If that pin is older than the
harness commit, new workspaces have no `.har/` and every command fails with
"Configure agent slot limits in .har/stages.json".

Before creating workspaces:

1. Commit `.har/` (and `AGENTS.md`) on the branch the orchestrator uses as its
   base.
2. If the orchestrator caches the base SHA, remove and re-add the repository
   (or otherwise refresh the pin) so new workspaces inherit that commit.
3. Then create workspaces and launch in them (with `har worktree off` set, or
   `--no-worktree` for a single launch).

Mission Control still keeps **one repository row** per git repo. Slot occupancy
is read from every linked worktree that stores its own `.har/` evidence, so a
session bound in an external workspace shows up on the slot page instead of
being blanked by an idle sync from the main checkout.
