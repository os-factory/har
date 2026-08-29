---
title: Harness files
description: The generated .har directory and the role of each file.
---

`.har/` is a **configuration surface**, not a copy of HAR's runtime. The
machinery lives once, in the npm package; the repository keeps the files that
describe *this project*. A profile may omit files that do not apply.

## Yours — the configuration surface

These files carry the project's behavior. Edit them freely; drift tracking
records your adaptations and `har env maintain` preserves them across upgrades
(see the [customization contract](/docs/guides/customization/)):

| Path | Purpose |
| --- | --- |
| `.har/harness.env` | Schema-validated configuration: primary app, services, ports, commands, limits |
| `.har/stages.json` | Registered stages, verification tiers, artifacts, slot range, and gate policy |
| `.har/stages/` | Project-owned stage scripts referenced from `stages.json` |
| `.har/hooks/` | Lifecycle hooks (`pre-launch.sh`, `post-launch.sh`, `pre-verify.sh`, `pre-teardown.sh`, `post-teardown.sh`) |
| `.har/plugins/` | Local plugins (`har plugin create <id>`) |
| `.har/env.template` | Expanded into `.env.agent.<id>` |
| `.har/ecosystem.agent.template.cjs` | PM2 primary-app process template (web profiles) |
| `.har/docker-compose.agent.yml` | Optional shared Docker services |
| `.har/README.md` | Human index and adapted operating guide |
| `.har/STAGES.md` | Stage registry, script-contract, and verification guide |

| `.har/justfile` | Optional `just` shortcuts |

## Managed files

CLI and MCP are the only entry points. Lifecycle stages in `stages.json`
dispatch by `kind` — there are no generated `.har/*.sh` wrappers.
[`har env eject`](/docs/guides/eject/) vendors the runtime into `.har/runtime/`
for offline ownership (`node .har/runtime/har.cjs env …`).

| Path | Purpose |
| --- | --- |
| `.har/manifest.json` | CLI-managed: runtime version, profile, checksums (never hand-edit) |

## Repo-root agent instruction files

Installed during `har onboard` / `har env init` (and refreshed on maintain):

| Path | Purpose |
| --- | --- |
| `AGENTS.md` | Canonical shared HAR workflow (Codex auto-loads this; cross-tool standard) |
| `CLAUDE.md` | Thin Claude Code pointer → `AGENTS.md` (only when Claude is a confirmed target) |
| `.cursor/rules/har-workflow.mdc` | Always-on Cursor injection (when Cursor is confirmed) |

Legacy `AGENT.md` (singular) is migrated into `AGENTS.md` and removed. Do not create it.

Keep instruction files **tracked**. A session worktree only materializes what is
in `HEAD`, so an untracked `CLAUDE.md` or `.claude/` leaves every agent slot
blind to the rules. `har env preflight` and `har env launch` warn when they
find untracked paths; see [Launch and recovery](/docs/reference/cli/#launch-and-recovery).

## Generated local state

These paths are normally gitignored:

| Path | Purpose |
| --- | --- |
| `.har/slots/agent-<id>.json` | Active session registry and source of truth for its work directory |
| `.env.agent.<id>` | Resolved per-slot environment |
| `.har/runs/` | Persisted CLI/MCP run records |
| `.har/validations/` | Exact-tree full-verification records |
| `.har/artifacts/` | Reports, logs, traces, screenshots, videos, and other stage output |
| `.har/state/` | Local harness state and registration |
| `.har/logs/` | Optional harness logs |
| `.har/maintain/` | Review bundle created during maintenance |
| `.har/ADAPT-PROMPT.md` | Current manual adaptation prompt |

Run history is written in the main checkout even when execution occurs in a session
worktree. Each record includes `workDir` so the two locations remain traceable.

## Where behavior lives

Machinery (worktrees, ports, provisioning, slot registry) lives in the packaged
runtime — never patch it into the harness. Project behavior has four sanctioned
homes: configuration values in `harness.env`, verification steps as registered
stages in `stages.json` / `.har/stages/`, lifecycle side effects as hooks in
`.har/hooks/`, and anything bigger as a plugin (bundled, npm, git, or local in
`.har/plugins/`). See the [customization contract](/docs/guides/customization/).
