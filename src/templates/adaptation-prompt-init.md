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

### `.har/ecosystem.agent.template.cjs`
PM2 processes matching how the project runs in dev (skip or simplify if not applicable).

### `.har/verify.sh`
Real typecheck, lint, test, and health check commands — replace all TODOs.

### `.har/CLAUDE.agent.md`
Detailed agent instructions: commands, credentials, architecture, definition of done.

### `.har/env.template`, `setup-infra.sh`, `docker-compose.agent.yml`
Adapt as needed for the project's infra.

### Port allocation
Agents run in parallel on configurable slot ids. Ports: `BASE + (AGENT_ID × 10)`.
Set slot limits in `.har/stages.json` (`agentSlots`) and `.har/harness.env` (`HARNESS_AGENT_SLOT_MIN` / `HARNESS_AGENT_SLOT_MAX`) based on machine capacity.

## Step 3 — Update repo-root `AGENT.md`

Coding agents discover the harness through two files:

1. **`AGENT.md`** (repo root) — short pointer, always read first
2. **`.har/README.md`** — full index of what's in the harness

If **no `AGENT.md` exists**, create one at the repo root using this structure:

- Link to `.har/README.md` and `.har/CLAUDE.agent.md`
- Essential commands (`./.har/launch.sh`, `./.har/verify.sh`, `./.har/teardown.sh`, etc.)
- Rules (no hardcoded ports, use `./.har/agent-cli.sh`, do not touch other agents' resources)
- Project-specific notes (stack, credentials, definition of done)

If **`AGENT.md` already exists**, add or update a concise **HAR / agent environment** section — do not replace unrelated content.

## Rules

1. Edit `.har/` files directly — no YAML runtime config
2. Always update `.har/README.md` to reflect current harness state
3. Reuse existing project commands from package.json, Makefile, CI, etc.
4. Replace all TODO placeholders
5. Do not edit `.har/manifest.json` — managed by the har CLI

When finished, summarize what you changed and confirm `./.har/verify.sh 1` commands are correct for this stack.
