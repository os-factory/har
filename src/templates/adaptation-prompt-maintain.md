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
- Review `.har/maintain/drift-report.json` (template drift, **missing port documentation vars**)

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

### HAR platform upgrades checklist

When upgrading `@osfactory/har` or adopting new harness standards:

**Generator 0.5.0 — `AGENTS.md` (canonical agent guide):**

- Repo-root **`AGENTS.md`** is now the shared HAR workflow contract (Codex auto-loads it). Do **not** create or keep **`AGENT.md`** (singular).
- If **`AGENT.md` exists**: merge any unique project notes into `AGENTS.md`, ensure a **HAR / agent environment** section is present, then **delete `AGENT.md`**.
- If **`AGENTS.md` is missing**: create it (HAR may already have scaffolded a managed section during `maintain` — fill **Project-specific notes** and keep the marked HAR section).
- If **`AGENTS.md` already exists**: add or refresh the managed **HAR / agent environment** section only — do not wipe unrelated project guidance.
- Keep **`CLAUDE.md`** as a **thin pointer** to `AGENTS.md` (Claude Code auto-loads `CLAUDE.md`). Never paste the full Cursor-rule / HAR workflow into `CLAUDE.md`.
- Update links in `.har/CLAUDE.agent.md` and `.har/README.md` from `AGENT.md` → `AGENTS.md` if they still point at the legacy name.
- Cursor still uses `.cursor/rules/har-workflow.mdc` (always-on); that rule should also say `AGENTS.md`.

**Generator 0.4.0 — primary app & shared infra services:**

- Migrate `harness.env` from boolean `HARNESS_INFRA_*` flags to the `HARNESS_INFRA_SERVICES` list (space-separated compose service names, e.g. `"db mailpit"`) and add the `har_infra_enabled()` helper — copy both from `.har/maintain/templates/harness.env`. Update every script that still tests `HARNESS_INFRA_POSTGRES`-style flags (`setup-infra.sh`, `launch.sh`, `teardown.sh`, `agent-cli.sh`) to use `har_infra_enabled <service>`.
- Set `HARNESS_PRIMARY_APP` in `harness.env` to the ONE app agents modify. Ensure `ecosystem.agent.template.cjs` starts only that app's processes. Move any other in-repo services agents depend on but don't change to shared infra: compose services in `docker-compose.agent.yml` or an optional `.har/ecosystem.shared.config.cjs` (processes `har-shared-<name>`; `setup-infra.sh` starts it when present — resync `setup-infra.sh` from the template to get this hook).
- Prune `docker-compose.agent.yml` to only the services this project uses; delete unused menu services and volumes.
- **Port & shared services:** ensure `.har/README.md` documents the allocation table and shared vs per-slot model; `harness.env` has every `HARNESS_*_PORT_*` var required for services in `HARNESS_INFRA_SERVICES` (copy missing vars from `.har/maintain/templates/harness.env` when drift reports them). Remove hardcoded ports from app code, tests, and `CLAUDE.agent.md`.
- Run the **cleanup checklist**: no TODO placeholders, no env blocks for removed services in `env.template`, no dead script branches, `.har/README.md` file table matches the actual files, `CLAUDE.agent.md` shows only real URLs/ports and commands, unused files deleted.

**Earlier standards:**

- Add **Run history** section to repo-root `AGENTS.md` if missing (shell vs `har env`, worktree vs runs location)
- Ensure `AGENTS.md` / `CLAUDE.agent.md` frame the harness as **how you run the project** (launch for manual testing/browser/screenshots; fix — don't work around — failing harness commands)
- Ensure `launch.sh` installs dependencies in fresh worktrees and resolves the project subdirectory inside the worktree (`git rev-parse --show-prefix`) for monorepos
- If the repo has multiple projects/harnesses, maintain the **"Harnesses in this repo"** table in root `AGENTS.md`, per-project pointer docs, and a single root Cursor rule
- Remove dead boilerplate files (CLI profile: `ecosystem.agent.template.cjs`, `env.template`, `attach.sh`)
- Align `launch.sh` / `harness.env` with worktree-default standard (`HARNESS_USE_WORKTREE=true`)
- Do **not** blindly overwrite customized `verify.sh`

## Step 3 — Refresh repo-root `AGENTS.md`

If harness commands, rules, or workflow changed, update the **HAR / agent environment** section in repo-root `AGENTS.md`:

- Links to `.har/README.md` and `.har/CLAUDE.agent.md`
- Preferred: HAR MCP tools or `har env …` (persists run history)
- Fallback: `./.har/*` shell scripts (when CLI is not installed)
- Run history rules (shell vs CLI/MCP, worktree vs `.har/runs/` location)
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
