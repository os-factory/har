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

## Agent environment

Runnable stages, verification, and definition of done live in **[`.har/`](.har/README.md)** — read `README.md` and `stages.json` there first.

**The harness is how you run this app.** To see Mission Control live (manual testing, browser, screenshots): `./.har/launch.sh 1` (or `har env launch 1`). Don't hand-roll dev-server startup; if a harness command fails, fix the harness or report it.
