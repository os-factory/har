Adapt the `.har/` harness in this repository so AI coding agents can run the project in isolated development environments.

## Your mission

Explore this repository, then edit files in `.har/` directly to make the harness runnable for this project.

**Do NOT** create a YAML config or JSON mapping file for runtime behavior. Put behavior directly in the harness scripts and templates.

## HAR profiles (pick the right one at init)

`har env init` scaffolds from one of three boilerplate profiles — **choose the profile that matches this repository**:

| Profile | Best for | What you get |
|---------|----------|--------------|
| `default` | **SaaS / web apps** (Next.js, Rails, full-stack, etc.) | Docker Compose shared infra, PM2 for primary app, per-slot ports and preview URLs |
| `cli` | **CLI tools, libraries, test-suite repos** (typical SWE-bench) | Git worktree by default, no PM2; optional Docker for databases; run project commands in isolation |
| `ios` | **Mobile iOS / Swift** | xcodebuild + iOS Simulator; scheme/project/simulator in `harness.env` |

```bash
har env init                  # default (SaaS/web)
har env init --profile cli    # libraries / CLI / polyglot test repos
har env init --profile ios    # iOS apps
```

Do **not** disable worktrees, rewrite launch into repo-root-only mode, or pick the wrong profile unless the project truly requires it.

## Profile: {{PROFILE}}

{{PROFILE_HINT}}

## Step 1 — Explore the repository

Read key files to understand the stack and how developers run the project today:

- Root manifests (`package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`, `Makefile`, etc.)
- Docker / compose files, CI config, README
- Existing test, lint, and build commands

## Step 2 — Adapt `.har/` files

Replace all TODO placeholders. Key files:

### Primary application & shared services (decide this FIRST)

Identify the **primary application** — the ONE app coding agents will modify and run per-slot. Everything else is shared and runs once for all slots:

1. **Primary app** → set `HARNESS_PRIMARY_APP` in `harness.env`; wire ONLY its dev processes into `ecosystem.agent.template.cjs` (a primary app may still need several processes, e.g. api + frontend of the same app).
2. **External dependencies** (database, cache, queue, mail, ...) → keep/add them as services in `docker-compose.agent.yml`, delete the menu entries the project doesn't use, and list the needed ones in `HARNESS_INFRA_SERVICES` (e.g. `"db redis"`). They start once via `setup-infra.sh` on fixed ports and serve every slot.
3. **Internal supporting services** (a monolith/monorepo's other services the agent depends on but is not changing) → do NOT start them per-slot. Run them once and shared: as compose services in `docker-compose.agent.yml`, or as PM2 processes in `.har/ecosystem.shared.config.cjs` (processes named `har-shared-<name>`, started automatically by `setup-infra.sh` when the file exists). Point the primary app at them through `env.template`.

Simple single-app repos need none of the extra machinery: one primary app, usually one `db` in `HARNESS_INFRA_SERVICES`, no shared ecosystem file.

### `.har/README.md` (required)
Clear index of the harness: what each file does, quick start, architecture, how to maintain. Update when anything in the harness changes.

### `.har/harness.env`
Primary app, ports, `HARNESS_INFRA_SERVICES`, migrate/seed commands, health check path.

**Toolchain provisioning:** set `HARNESS_ECOSYSTEM` (`auto` detects from manifests) and optional `HARNESS_INSTALL_CMD`. Launch runs `provision-toolchain.sh`, writes resolved paths (`PYTHON_BIN`, `NODE_BIN`, `NPM_BIN`, `XCODEBUILD_BIN`, …) into `.env.agent.<id>`. Verify steps **must** use those paths — never hardcode venv or interpreter locations.

### `.har/ecosystem.agent.template.cjs` (default profile only)
PM2 processes for the primary application only, matching how it runs in dev. Skip entirely for the CLI profile.

### `.har/verify.sh`
Adapt verification for this repository's toolchain. Step lists in the template are
**examples, not exhaustive** — add, remove, or reorder `run_step` calls to match
how this project is built and tested. Use toolchain variables from `.env.agent.<id>`
(e.g. `${NPM_BIN:-npm}`, `${PYTHON_BIN:-python3}`, `${XCODEBUILD_BIN:-xcodebuild}`).
The stock verify section is keyed by `HARNESS_ECOSYSTEM`; it is a starting point,
not the repo's final contract. Replace conventions that do not match this project.

**Tier contract:**

| Mode | Command | Intent |
|------|---------|--------|
| Quick (default) | `har env verify 1` | Smoke — compile / import / build / health only |
| Full | `har env verify 1 --full` | Functional proof — registered `verificationStages` that show the work actually works |

- **Quick** must stay fast and minimal (syntax, compile, import smoke) — not the full test suite.
- **Full** is how agents prove changes are **functional**, not merely compiling. Register stages in `.har/stages.json` `verificationStages` (see `.har/STAGES.md`). Prefer a small **behavior** check over dumping the entire CI suite: a CLI dry-run, one API/workflow smoke, import+exercise of the changed module, a focused regression script, health+auth path, etc. Full-suite unit tests are fine when they are already the project's real check — they are not the goal by themselves.
- During adaptation, add at least one verification stage that a coding agent can use as definition of done for product changes. Example:

  ```bash
  har env add-stage feature-smoke --custom --kind test --command "<project-appropriate functional check>" --verification
  ```

- Document in `.har/CLAUDE.agent.md` that for a **specific bug/feature**, agents must
  add or reuse a **change-specific** stage with **fail-before / pass-after** (fails
  on the broken behavior, passes after the fix). Smoke-only `--full` is not done.
- Ensure verification stages can **run in the slot** (editable installs, built
  native extensions, `${PYTHON_BIN}` / toolchain from `.env.agent.<id>`). Stages
  that only fail with missing modules because launch never built the package are
  harness bugs — fix `launch` / install, do not treat them as product proof.
- Reuse real commands from `package.json`, `Makefile`, CI, `pyproject.toml`, etc.
- Remove stock npm/pytest/go/cargo/maven/gradle examples that do not apply.
- Replace all TODO placeholders in both tiers.

### Readiness vs liveness (required)
Do not treat a passing health check as adaptation complete. Before finishing,
make the harness explicit about the layers that apply to this repository:

1. **Infra ready** — shared services are running and template data stores exist.
2. **Slot data ready** — every per-slot data store is created or cloned, not only
   the primary database.
3. **Process ready** — the primary app processes are online and
   `HARNESS_HEALTH_CHECK_PATH` passes.
4. **Agent usable** — a real workflow an agent needs is possible: documented
   credentials work, a tenant/org/project exists when the app requires one, the
   UI is not blocked by dev-server overlays, or an authenticated API smoke works.

Compare the harness against the project's full local-dev setup. If the harness
intentionally skips slow or heavy steps (full seed, optional services, asset
mode, background daemons), add the minimum substitute directly in `.har/`
scripts or document why no substitute is needed. In particular:

- If `HARNESS_DB_SEED_CMD` is empty or schema-only, add an idempotent minimal
  bootstrap step for required tenants/users/settings, or document why schema-only
  is enough.
- If the app has multiple databases, schemas, queues, object stores, search
  indexes, or other per-slot state, provision all of them in `setup-infra.sh`
  and `launch.sh`.
- If launch generates config, validate the nested keys the app actually reads
  against upstream examples/defaults, not only top-level keys.
- If the dev server can block agents with overlays or noisy HMR failures,
  choose and document an agent-friendly asset mode.
- Put Layer 3 checks in `verify --full`, a project-owned readiness script, or
  documented smoke URLs. Health alone is not sufficient for UI/auth apps.
- Ensure `launch.sh` writes the slot registry before slow or fragile steps, runs
  `provision-toolchain.sh` to install deps and record toolchain paths in
  `.env.agent.<id>`, and `verify.sh` resolves env/work dir through `agent-slot.sh`.

### Optional Playwright stage
If the user ran `har env add-plugin playwright` (or `@playwright/test` is in package.json):

- Adapt `tests/**` selectors and API paths for this stack
- Ensure `HARNESS_HEALTH_CHECK_PATH` matches the app health route used in API smoke tests
- `verify --full` runs `browser-e2e` automatically when `.har/stages/browser-e2e.sh` exists
- Do not wire Playwright into quick `verify` unless the team wants e2e on every loop

See `.har/stages/PLAYWRIGHT.md` when present.

### `.har/CLAUDE.agent.md`
Detailed agent instructions: commands, credentials, architecture, definition of done.

### `.har/env.template`, `setup-infra.sh`, `docker-compose.agent.yml`
Adapt as needed for the project's infra.

### Port allocation & shared services

Document and configure ports in `.har/harness.env` and `.har/README.md`. Use the bundled template's port-allocation block as the contract — do not hardcode ports in app code or tests.

**Per-slot app ports** (default / PM2 profile only):

| Layer | Scope | Rule | On conflict |
|-------|-------|------|-------------|
| Frontend | Per slot | `HARNESS_FE_BASE_PORT + (AGENT_ID × HARNESS_PORT_STEP)` | Scan `STEP` increments within the slot lane |
| API | Per slot | `HARNESS_API_BASE_PORT + (AGENT_ID × STEP)` | Same scan policy |
| Node debug | Per slot | `9200 + (AGENT_ID × STEP)` | Same scan policy |

**Shared infra ports** (one per machine, all profiles when the service is in `HARNESS_INFRA_SERVICES`):

| Service | Default var | On conflict |
|---------|-------------|-------------|
| Postgres | `HARNESS_DB_PORT_DEFAULT` | Scan `HARNESS_DB_PORT_SCAN_START..END` |
| MinIO | `HARNESS_MINIO_PORT_DEFAULT` (+ console) | Scan configured ranges |
| Mailpit | `HARNESS_MAILPIT_*_PORT_DEFAULT` | Scan configured ranges |
| Headless browser | `HARNESS_BROWSER_PORT_DEFAULT` | Scan configured ranges |

Set slot limits in `.har/stages.json` (`agentSlots`) based on machine capacity. `har env maintain --finalize` syncs legacy `HARNESS_AGENT_SLOT_*` exports in `harness.env`.

**Port / infra checklist:**

- [ ] `.har/harness.env` has `HARNESS_FE_BASE_PORT`, `HARNESS_API_BASE_PORT`, `HARNESS_PORT_STEP` (default profile) or explains why they are absent (CLI/iOS)
- [ ] For each service in `HARNESS_INFRA_SERVICES`, matching `HARNESS_*_PORT_DEFAULT` and `SCAN_*` vars exist in `harness.env`
- [ ] `.har/README.md` has a **Port & shared services** section (allocation table, shared vs per-slot, do-not rules)
- [ ] App code and tests read ports from `.env.agent.<id>` / `agent-cli.sh` / slot registry — no hardcoded `3000`, `15432`, `3847`, etc.
- [ ] `env.template` and `CLAUDE.agent.md` show resolved ports via variables, not literals
- [ ] Monorepos with `har control up`: document slot-1 conflict if the app port overlaps (e.g. Mission Control on 3847)

### Git worktree
`launch.sh` creates an isolated session worktree at `~/worktrees/<base>-<sha4>-har-agent-<id>-<rand4>` by default (`HARNESS_USE_WORKTREE=true`) and records it in `.har/slots/agent-<id>.json`. Agents should commit from that worktree, not the main checkout.

## Step 3 — Update repo-root `AGENT.md`

Coding agents discover the harness through two files:

1. **`AGENT.md`** (repo root) — short pointer, always read first
2. **`.har/README.md`** — full index of what's in the harness

If **no `AGENT.md` exists**, create one at the repo root using this structure:

- Link to `.har/README.md` and `.har/CLAUDE.agent.md`
- State plainly: **the harness is how you run this project** — to see the app live (manual testing, browser, screenshots), `launch` a slot; never hand-roll docker/dev-server startup, and never work around a failing harness command with ad-hoc setup (fix or report it instead)
- Preferred commands: HAR MCP tools or `har env launch/verify/teardown` (persists run history)
- Shell fallback: `./.har/launch.sh`, `./.har/verify.sh`, `./.har/teardown.sh` (when CLI is not installed)
- Rules (no hardcoded ports, use `./.har/agent-cli.sh`, do not touch other agents' resources)
- Project-specific notes (stack, credentials, definition of done)
- **Definition of done:** quick verify is smoke only; finishing a change requires `har env verify <id> --full` (registered functional `verificationStages`). If no stage proves the change works, add one with `har env add-stage … --custom --verification` before stopping — do not declare done on compile/import alone.

If **`AGENT.md` already exists**, add or update a concise **HAR / agent environment** section — do not replace unrelated content.

### Monorepos / multiple harnesses

If this repository contains **more than one project or `.har` harness** (check for `.har/` directories above or below this one):

- Maintain a **"Harnesses in this repo"** table in the ROOT `AGENT.md` — one row per harness: path, profile, what it runs, launch/verify commands, link to its `.har/README.md`. Lead with "pick the harness that owns the files you are changing."
- Keep a small `AGENT.md` (and `CLAUDE.md` pointer) **inside each project directory** for local discovery, with a back-link to the root index.
- Keep ONE Cursor rule at the repo root (`.cursor/rules/har-workflow.mdc`) listing all harnesses — not one rule per project.

Include a **Run history** subsection:

- `./.har/*.sh` does not write run records
- `har env …` and MCP write to `.har/runs/YYYY-MM-DD/HH-mm-ss_<stageId>_agent-<id>.json`
- With worktrees, code runs in the worktree but run JSON lives in the main checkout `.har/runs/`
- Document MCP/CLI as the preferred agent interface; shell scripts as fallback

## Step 4 — Cleanup checklist (required)

The boilerplate ships more than any single repository needs. Strip it down to strictly what this project uses — leftover template content confuses agents and rots. Verify each item:

- [ ] `docker-compose.agent.yml` contains ONLY services this project uses (menu entries and their volumes deleted); `HARNESS_INFRA_SERVICES` lists exactly those services
- [ ] `env.template` has no env blocks for removed services (MinIO/S3, mailpit, headless browser, ...) and no vars the app never reads
- [ ] `harness.env` has no leftover config for features not in use (e.g. `HARNESS_TEMPLATE_DB` and migrate/seed commands when there is no database)
- [ ] Scripts (`launch.sh`, `setup-infra.sh`, `teardown.sh`, `agent-cli.sh`, `verify.sh`) contain no dead branches for services this project will never enable — prune, don't comment out
- [ ] No `TODO` placeholders remain anywhere in `.har/`
- [ ] Unused harness files are deleted (e.g. `attach.sh` when tmux isn't part of the workflow; CLI profile: `ecosystem.agent.template.cjs`, `env.template`)
- [ ] `.har/README.md` file table lists exactly the files that exist — no more, no less
- [ ] `.har/CLAUDE.agent.md` shows only real URLs/ports/credentials (e.g. drop the Frontend row for an API-only project) and project commands that actually run
- [ ] If full seed/setup is skipped, `.har/` provides a minimal bootstrap or clearly documents why none is needed
- [ ] All per-slot data stores are provisioned, not just the primary database
- [ ] `.har/CLAUDE.agent.md` defines what "agent usable" means for this repo: login/API smoke, credentials, required default data, and known skipped dev-setup steps
- [ ] `.har/README.md` documents port allocation and shared-service model; `harness.env` has the port knobs for every enabled infra service
- [ ] No hardcoded default ports (`3000`, `15432`, `3847`, …) in app code, tests, or harness docs — use agent env / slot registry

## Rules

1. Edit `.har/` files directly — no YAML runtime config
2. Always update `.har/README.md` to reflect current harness state
3. Reuse existing project commands from package.json, Makefile, CI, etc.
4. Replace all TODO placeholders
5. Do not edit `.har/manifest.json` — managed by the har CLI

When finished, summarize what you changed, confirm verification commands (`har env verify 1 --full` or `./.har/verify.sh 1 --full`) are correct for this stack, and record the adaptation with `har env maintain --finalize --summary "<what changed>"`.
