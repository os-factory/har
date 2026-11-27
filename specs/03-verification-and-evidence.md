# 03 — Verification, evidence and work identity

Binding "passed" to exact code and to the durable work it belongs to.
Background: [ADR-0001](../docs/architecture/decisions/0001-work-identity.md).

- **VER-1** MUST — Quick verify runs the fast checks the project's `verify` stage defines; full verify runs every stage in `verificationStages` and is the repository's completion contract.
- **VER-2** MUST — Every CLI and MCP stage execution writes a run record under the main checkout's `.har/runs/YYYY-MM-DD/HH-mm-ss_<stage>_agent-<id>.json` with repository, stage, status, timing, trigger, result, command and work dir.
- **VER-3** MUST — A full verify hashes the complete working-tree state and records a validation under `.har/validations/`; any later source edit invalidates it.
- **VER-4** MUST — The commit gate's pre-commit hook compares the staged tree with a passing full validation and blocks or warns per `commitGate.mode` (`block`/`warn`) and `scope` (`worktrees`/`all`); post-commit binds the commit SHA to that validation.
- **VER-5** MUST — The gate decides on content hashes only, never on timestamps or branch names.
- **VER-6** MUST — A launch may bind a caller-provided work unit (`workUnitId` + optional source, URL, title, parent); work-unit records live in the main checkout under `.har/work-units/` and store no mutable tracker fields.
- **VER-7** MUST — Each fresh launch bound to work gets an immutable `attemptId`; runs and telemetry carry both `workUnitId` and `attemptId`, and only one attempt per work unit is active at a time.
- **VER-8** SHOULD — A running slot can be bound to a work unit after launch (`work-bind`), and secondary links can be attached (`work-link`).
- **VER-9** MUST — Declared stage artifacts (files, logs, screenshots, traces, URLs) are discoverable through CLI, MCP and Mission Control.
- **VER-10** MUST — Tearing down a slot whose work unit has no outcome records `abandoned` for that attempt and never overwrites an existing outcome; the next launch bound to that unit reopens it and keeps the earlier outcome in `previousOutcomes`.
- **VER-11** MUST — Run records can be listed and fetched by run id (`har env runs list|get`, `har_list_runs`, `har_get_run`), including records stored in the legacy flat layout.
- **VER-12** MUST — Commit-gate onboarding records the visible policy: preference `never` writes the policy without installing hooks, `always` installs repository-wide hooks.
