Update the `.har/` harness in this repository to reflect current codebase changes.

## Your mission

The harness already exists. Inspect what changed in the repo since the harness was last updated, then edit `.har/` files so coding agents can still run and verify the project correctly.

**Do NOT** create a YAML config or JSON mapping file for runtime behavior. Put behavior directly in the harness scripts and templates.

{{MAINTAIN_BUNDLE_SECTION}}

## Step 1 — Inspect the repository

Compare the current repo against the existing harness:

- Root manifests, CI, Docker, README
- New or changed test, lint, build, migrate, or seed commands
- New services, ports, or environment variables
- Review `.har/maintain/drift-report.json` (two-signal drift, **missing port documentation vars**).
  Drift statuses: `upstream-updated` (bundled template moved since your last finalize — apply the diff),
  `conflict` (template moved **and** the file was edited locally — merge, keep repo customizations),
  `adapted` (local edits only — **no action**, never revert to stock; finalize blesses them).

## Step 2 — Update `.har/` files

Prefer targeted edits over full rewrites. Key files to review:

### `.har/README.md` (required)
Keep this accurate — it is the harness index. Update whenever scripts, stages, or workflow change.

### `.har/harness.env`, `verify.sh`, `provision-toolchain.sh`, `ecosystem.agent.template.cjs`, `CLAUDE.agent.md`
Align commands and instructions with the current stack. Verify steps must use toolchain paths from `.env.agent.<id>` (`PYTHON_BIN`, `NPM_BIN`, `XCODEBUILD_BIN`, …) — never hardcoded venv or interpreter paths. `NPM_BIN` may be bun, pnpm, or yarn, so Node steps must use `${NPM_BIN:-npm} run <script>` and avoid npm-only flags such as `--prefix`. Replace stock ecosystem conventions that do not match the repository; do not leave npm/pytest/go/cargo/maven/gradle examples in place by accident.

### `.har/env.template`, `setup-infra.sh`, `docker-compose.agent.yml`
Update only if infra changed.

### Readiness vs liveness regression check
Do not treat a passing health check as proof that the harness is still usable.
When maintaining an existing harness, re-check the layers that apply:

1. **Infra ready** — shared services and template data stores still match the app.
2. **Slot data ready** — every per-slot data store is created or cloned, not only
   the primary database.
3. **Process ready** — app processes are online and `HARNESS_HEALTH_CHECK_PATH`
   passes.
4. **Agent usable** — documented credentials/workflows still work, required
   default data exists, UI/API smoke is not blocked by asset/dev-server issues,
   and any skipped full-dev setup has a minimal substitute or clear limitation.

Look specifically for drift introduced since the last adaptation:

- A seed command was removed or made schema-only without a minimal bootstrap.
- A new database, schema, queue, object store, search index, or other per-slot
  dependency was added but launch only provisions the original primary store.
- Config generation writes plausible top-level keys while the app reads nested
  defaults from another file.
- The dev server mode is fine for humans but blocks browser automation or agents
  with overlays/noisy HMR.
- `verify.sh` became health-only and no longer checks the key workflow that makes
  the slot usable.
- `launch.sh` writes the slot registry only after fragile late steps; partial
  launches must remain discoverable by verify/status/teardown.

Update `.har/CLAUDE.agent.md` with skipped setup steps, substitutes, credentials,
and the repo-specific definition of "agent usable."

### Custom lifecycle behavior — `.har/hooks/`

Custom launch/verify/teardown needs belong in lifecycle hooks, never in edits
to harness machinery: `.har/hooks/pre-launch.sh`, `post-launch.sh`,
`pre-verify.sh`, `pre-teardown.sh`, `post-teardown.sh`. Hooks receive
`AGENT_ID`, `WORK_DIR`, `ENV_FILE`, `HAR_HARNESS_DIR`, and `HAR_PORT_<NAME>`
(contract `HAR_HOOK_CONTRACT=1`). Failing `pre-*` hooks abort the operation;
`post-*` failures warn unless `HARNESS_HOOK_POST_FAILURE=fail`. Hooks are
user-owned and never drift-checked — if a past adaptation patched machinery
scripts for a lifecycle side effect, move that code into a hook.

### HAR platform upgrades

Platform-shape upgrades are **code, not a checklist**: the har CLI carries a
versioned migration registry keyed on the manifest's `runtimeVersion`.
`har env maintain` detects an old harness shape, writes `.har/MIGRATE-PROMPT.md`,
and `har env maintain --migrate` applies the mechanical steps (shims, pure-config
`harness.env` with `HARNESS_INFRA_SERVICES` / `HARNESS_INFRA_PORT_LANES`
conversions, machinery removal) with backups under `.har/migrate/backup/`.

If a `.har/MIGRATE-PROMPT.md` exists, **follow it instead of this prompt** and
come back here afterwards. Two standing rules:

- Verification customization lives in `stages.json` / `.har/stages/` — the
  top-level `*.sh` files are generated shims, safe to regenerate.
- Repo-root agent docs (`AGENTS.md`, `CLAUDE.md`) follow Step 3 below.

## Step 3 — Refresh repo-root `AGENTS.md`

If harness commands, rules, or workflow changed, update the **HAR / agent environment** section in repo-root `AGENTS.md`:

- Links to `.har/README.md` and `.har/CLAUDE.agent.md`
- Commands: HAR MCP tools or `har env …`
- Shell shims: `./.har/*.sh` — thin delegates to `har env`, same run records
- Run history (worktree runs record to the main checkout `.har/runs/`)
- Agent rules (ports, agent-cli.sh, isolation)
- Project-specific notes

If `AGENTS.md` does not mention HAR yet, add a concise section. If it already has a HAR section, update it minimally — do not replace unrelated content.

Do **not** create `AGENT.md` (singular). If legacy `AGENT.md` exists, merge unique notes into `AGENTS.md` and delete `AGENT.md`. Keep `CLAUDE.md` as a thin pointer to `AGENTS.md`.

## Rules

1. Prefer targeted edits — keep working harness behavior where still valid
2. Always update `.har/README.md` when anything in the harness changes
3. Reuse existing project commands from package.json, Makefile, CI, etc.
4. Replace any remaining TODO placeholders
5. Do not edit `.har/manifest.json` — managed by the har CLI

When finished, summarize what you changed, confirm verification commands still match the repo, and record the adaptation with `har env maintain --finalize --summary "<what changed>"` (updates the manifest checksums).
