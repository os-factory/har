Adapt the `.har/` harness in this repository so AI coding agents can run the project in isolated development environments.

## Your mission

Explore this repository, then edit files in `.har/` directly to make the harness runnable for this project.

**Do NOT** create a YAML config or JSON mapping file for runtime behavior. Put behavior directly in the harness scripts and templates.

## Profile: {{PROFILE}}

{{PROFILE_HINT}}

## Step 1 — Explore the repository

Read key files to understand the stack and how developers run the project today:

- Root manifests (`package.json`, `go.mod`, `pyproject.toml`, `Cargo.toml`, `Makefile`, etc.)
- Docker / compose files, CI config, README
- Existing test, lint, and build commands

## Step 2 — Adapt `.har/` files

Replace all TODO placeholders. Key files:

### `.har/README.md` (required)
Clear index of the harness: what each file does, quick start, architecture, how to maintain. Update when anything in the harness changes.

### `.har/harness.env`
Ports, infra flags, migrate/seed commands, health check path.

### `.har/ecosystem.agent.template.cjs` (default profile only)
PM2 processes matching how the project runs in dev. Skip entirely for the CLI profile.

### `.har/verify.sh`
Real typecheck, lint, test, and health check commands — replace all TODOs.

### Optional Playwright stage
If the user ran `har env add-stage playwright` (or `@playwright/test` is in package.json):

- Adapt `tests/**` selectors and API paths for this stack
- Ensure `HARNESS_HEALTH_CHECK_PATH` matches the app health route used in API smoke tests
- `verify --full` runs `browser-e2e` automatically when `.har/stages/browser-e2e.sh` exists
- Do not wire Playwright into quick `verify` unless the team wants e2e on every loop

See `.har/stages/PLAYWRIGHT.md` when present.

### `.har/CLAUDE.agent.md`
Detailed agent instructions: commands, credentials, architecture, definition of done.

### `.har/env.template`, `setup-infra.sh`, `docker-compose.agent.yml`
Adapt as needed for the project's infra.

### Port allocation
Agents run in parallel on configurable slot ids. Ports: `BASE + (AGENT_ID × 10)`.
Set slot limits in `.har/stages.json` (`agentSlots`) and `.har/harness.env` (`HARNESS_AGENT_SLOT_MIN` / `HARNESS_AGENT_SLOT_MAX`) based on machine capacity.

### Git worktree
`launch.sh` creates an isolated worktree at `~/worktrees/<project>-agent-<id>` by default (`HARNESS_USE_WORKTREE=true`). Agents should commit from that worktree, not the main checkout.

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

## Rules

1. Edit `.har/` files directly — no YAML runtime config
2. Always update `.har/README.md` to reflect current harness state
3. Reuse existing project commands from package.json, Makefile, CI, etc.
4. Replace all TODO placeholders
5. Do not edit `.har/manifest.json` — managed by the har CLI

When finished, summarize what you changed and confirm verification commands (`har env verify 1 --full` or `./.har/verify.sh 1 --full`) are correct for this stack.
