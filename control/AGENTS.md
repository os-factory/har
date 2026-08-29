# HAR Mission Control — Agent Development Guide

Next.js App Router dashboard for harness runs, repositories, and agent slots.

Part of the har monorepo — this app has its own harness (`control/.har/`). For work on the CLI, the docs site, or the index of all harnesses in this repo, see the root [AGENTS.md](../AGENTS.md).

## Stack

- Prisma + SQLite, Zod (`@har/schemas`)

## Layout

```
src/app/           routes and API handlers
src/components/    UI (shadcn + domain components)
src/server/        business logic
prisma/            schema
```

<!-- har:agent-environment:start -->
## HAR / agent environment

This repository uses a `.har/` harness. It is **how you run and verify this
project** — launch a slot for live apps, browsers and screenshots; never
hand-roll docker or dev-server startup. If a harness command fails, fix the
harness or report it; do not fall back to ad-hoc commands.

1. **Launch first** — `har_launch_environment` / `har env launch <id>`. Make ALL
   edits under the returned **work dir**, never the main checkout. Bind tracker
   work with `--work-id` / `--work-url` when the task names an issue.
2. **Verify before done** — `har_run_verification` (`full: true`) /
   `har env verify <id> --full`. Commit in the session worktree.
3. **Stop at handoff** — report summary, session branch and preview URLs, then
   wait. Never autonomously `complete`, `teardown`, push, or open a PR.

Occupied slots always block: `complete` / `teardown`, then launch. Customize the
harness only through `harness.env`, `stages.json` + `.har/stages/`, `.har/hooks/`
and `.har/plugins/` — there is no generated `.har/*.sh` entry-point surface.

Full detail — slot environment, readiness, definition of done, project commands,
commit gate: [`.har/README.md`](.har/README.md) and [`.har/stages.json`](.har/stages.json).
<!-- har:agent-environment:end -->

## Project-specific notes

- **Primary app:** Next.js Mission Control (`HARNESS_PRIMARY_APP=web`) on slot ports (slot 1 → **3847**).
- **Database:** per-slot SQLite `prisma/agent_<id>.db` — no shared Postgres.
- **Other harnesses:** root `.har/` (CLI) · `docs/.har/` (docs site). See the root [AGENTS.md](../AGENTS.md).
