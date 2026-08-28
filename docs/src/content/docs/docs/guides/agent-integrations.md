---
title: Agent integrations
description: Install HAR workflows for Cursor, Claude Code, Codex, and MCP clients.
---

HAR's runtime is agent-agnostic. Integrations teach an agent when and how to use the
same repository-owned harness.

## Project instruction files

During `har onboard` / `har env init`, HAR detects existing entrypoints (`AGENTS.md`,
legacy `AGENT.md`, `CLAUDE.md`, `.cursor/`, `.claude/`, `~/.codex`), prints what it
found, and shows where HAR instructions will be installed after you confirm targets:

| File | Role |
| --- | --- |
| `AGENTS.md` | Canonical shared HAR workflow section (always created/updated — Codex auto-loads this) |
| `CLAUDE.md` | Thin Claude Code pointer → `AGENTS.md` (when Claude is confirmed) |
| `.cursor/rules/har-workflow.mdc` | Always-on Cursor injection (when Cursor is confirmed) |
| Skills / prompts | `/setup-har`, `/har-wt`, `/har-maintain` for confirmed agents |

Legacy `AGENT.md` is migrated into `AGENTS.md` and removed. Existing project-owned
`AGENTS.md` content is preserved; HAR only upserts a marked HAR section.

## Managed workflows

HAR provides three workflows:

| Workflow | Purpose |
| --- | --- |
| `/setup-har` | Install HAR, choose a profile, initialize, adapt, prove, and commit a harness |
| `/har-wt` | Launch a slot, work only in its worktree, and verify the task |
| `/har-maintain` | inspect drift, apply maintenance updates, finalize, and re-verify |

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

Any MCP client can discover HAR's generic tools for initialization, preflight,
launch, recovery, stages, verification, status, logs, completion, teardown,
artifacts, runs, and Mission Control.

MCP is the preferred interface in agents because it returns structured results
the model does not have to parse. Run history is identical on every surface —
the `./.har/*.sh` shims, `har env …`, and MCP all run the same packaged runtime
and write the same records.
