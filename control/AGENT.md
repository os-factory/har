# HAR Mission Control — Agent Development Guide

Next.js App Router dashboard for harness runs, repositories, and agent slots.

## Stack

- Next.js, shadcn/ui, Tailwind, Prisma + PostgreSQL, Zod (`@har/schemas`)

## Layout

```
src/app/           routes and API handlers
src/components/    UI (shadcn + domain components)
src/server/        business logic
prisma/            schema
```

## Agent environment

Runnable stages, verification, and definition of done live in **[`.har/`](.har/README.md)** — read `README.md` and `stages.json` there first.
