# 01 — Harness contract (`.har/`)

The repository-owned contract that tells any agent how to run and verify the project.
Background: [ADR-0002](../docs/architecture/decisions/0002-shim-runtime.md).

- **CON-1** MUST — The harness runtime lives once, in the `@osfactory/har` package; a target repository's `.har/` holds only project-owned configuration: `harness.env`, `stages.json` + `.har/stages/`, `.har/hooks/`, `.har/plugins/` and adapted docs.
- **CON-2** MUST — `harness.env` and `stages.json` are schema-validated; invalid configuration is reported, never silently ignored.
- **CON-3** MUST — A stage is project-defined data (id, kind, command, accepted arguments, optional artifacts) whose kind is one of `setup`, `launch`, `verify`, `test`, `inspect`, `reset`, `teardown`, `custom`; core never hardcodes stack-specific stages.
- **CON-4** MUST — `har onboard` / `har_init_harness` scaffold a `.har/` from a profile and print an adaptation prompt for the coding agent.
- **CON-5** MUST — `har env maintain` reports drift between the installed harness and current templates, distinguishing user edits from upstream updates, without overwriting adaptations.
- **CON-6** MUST — `har env doctor` checks the harness for structural problems and runs automatically in `maintain` and before `launch`.
- **CON-7** SHOULD — Stack capabilities (ports, PM2, Simulator, …) are detected from marker files and expressed as ordered profiles, not forked logic in core.
- **CON-8** MUST — Lifecycle hooks are optional project-owned scripts `.har/hooks/<hook>.sh`, run at five fixed points (`pre-launch`, `post-launch`, `pre-verify`, `pre-teardown`, `post-teardown`) and never drift-checked; a failing `pre-*` hook aborts the operation with its exit code, a failing `post-*` hook only warns unless `HARNESS_HOOK_POST_FAILURE=fail`.
- **CON-9** MUST — HAR keeps its agent guidance in a marked section of `AGENTS.md` (created from the template, appended to or updated in an existing file) and never drops content outside its markers; `CLAUDE.md` is never created when absent, and an existing one keeps the user's content and gains an import of `AGENTS.md`.
- **CON-10** SHOULD — The Cursor rule `.cursor/rules/har-workflow.mdc` is scaffolded only in a Cursor workspace or on `--cursor-rule`, skipped on `--no-cursor-rule`, and refreshed by `maintain` when it already exists.
- **CON-11** SHOULD — Managed agent skills are recorded in the harness manifest; a skill file the user modified is neither overwritten (unless forced) nor removed.
- **CON-12** MUST — `har env eject` vendors the runtime into `.har/` and records the choice; `har env adopt` removes it again and preserves configuration; ejecting twice or adopting a non-ejected harness is refused, and `doctor` validates the ejected contract.
- **CON-13** MUST — On a pre-1.0 harness plain `maintain` only detects the pending migration and writes a plan and migration prompt; `maintain --migrate` applies the mechanical steps with backups and stamps the manifest; an ejected harness is never treated as pre-1.0.
- **CON-14** MUST — `doctor` fails with a single upgrade error when the CLI is older than the version that wrote the harness.
