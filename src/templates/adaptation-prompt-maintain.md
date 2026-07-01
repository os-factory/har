Update the `.har/` harness in this repository to reflect current codebase changes.

## Your mission

The harness already exists. Inspect what changed in the repo since the harness was last updated, then edit `.har/` files so coding agents can still run and verify the project correctly.

**Do NOT** create a YAML config or JSON mapping file for runtime behavior. Put behavior directly in the harness scripts and templates.

## Step 1 — Inspect the repository

Compare the current repo against the existing harness:

- Root manifests, CI, Docker, README
- New or changed test, lint, build, migrate, or seed commands
- New services, ports, or environment variables
- Run `har env maintain` drift report (generator version, template checksum mismatches)

## Step 2 — Update `.har/` files

Prefer targeted edits over full rewrites. Key files to review:

### `.har/README.md` (required)
Keep this accurate — it is the harness index. Update whenever scripts, stages, or workflow change.

### `.har/harness.env`, `verify.sh`, `ecosystem.agent.template.cjs`, `CLAUDE.agent.md`
Align commands and instructions with the current stack.

### `.har/env.template`, `setup-infra.sh`, `docker-compose.agent.yml`
Update only if infra changed.

### HAR platform upgrades checklist

When upgrading `@har/cli` or adopting new harness standards:

- Add **Run history** section to repo-root `AGENT.md` if missing (shell vs `har env`, worktree vs runs location)
- Remove dead boilerplate files (CLI profile: `ecosystem.agent.template.cjs`, `env.template`, `attach.sh`)
- Align `launch.sh` / `harness.env` with worktree-default standard (`HARNESS_USE_WORKTREE=true`)
- Do **not** blindly overwrite customized `verify.sh`

## Step 3 — Refresh repo-root `AGENT.md`

If harness commands, rules, or workflow changed, update the **HAR / agent environment** section in repo-root `AGENT.md`:

- Links to `.har/README.md` and `.har/CLAUDE.agent.md`
- Essential `./.har/*` commands and `har env …` for run history
- Run history rules (shell vs CLI, worktree vs `.har/runs/` location)
- Agent rules (ports, agent-cli.sh, isolation)
- Project-specific notes

If `AGENT.md` does not mention HAR yet, add a concise section. If it already has a HAR section, update it minimally — do not replace unrelated content.

## Rules

1. Prefer targeted edits — keep working harness behavior where still valid
2. Always update `.har/README.md` when anything in the harness changes
3. Reuse existing project commands from package.json, Makefile, CI, etc.
4. Replace any remaining TODO placeholders
5. Do not edit `.har/manifest.json` — managed by the har CLI

When finished, summarize what you changed and confirm verification commands still match the repo.
