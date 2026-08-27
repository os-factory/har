---
title: The road to 1.0
description: Why .har/ became a configuration surface, what broke on the way, and what we learned shipping HAR 1.0.0.
---

HAR 1.0.0 changes one thing, and everything follows from it: **`.har/` stops being
a vendored copy of HAR's runtime and becomes a configuration surface.** This post
explains why we did it, what actually broke while dogfooding the migration on
HAR's own repository, and the lessons that ended up encoded in the product. How
we ran the work itself — stations, a ratchet, a gate on a real clone — is a
separate piece: [The factory line](/blog/the-factory-line/).

## The problem we shipped ourselves

Pre-1.0, `har env init` copied the runtime into every project: an 812-line
`agent-slot.sh`, a provisioning script, and lifecycle scripts full of logic.
Across three boilerplate profiles that meant roughly 8,800 lines of template,
about 2,400 of them byte-identical duplicates — one helper block was copied
seven times. The architecture audit condensed the damage into four findings:

- **Forked boilerplates.** Fixing a bug meant fixing it three times, and
  usually meant a user's already-adapted harness never got the fix at all.
- **Machinery outnumbered config.** 75–80% of installed files were runtime
  internals users were never supposed to touch — but nothing stopped them.
- **Three invocation surfaces, three behaviors.** The CLI, the MCP tools, and
  the raw scripts each reimplemented ports, preflight, and slot logic. Raw
  script runs never wrote run or validation records, so the commit gate could
  be satisfied on one path and bypassed on another.
- **Drift detection was noise.** Every intentional adaptation looked identical
  to accidental corruption, so people learned to ignore the warnings.

## The 1.0 model

The runtime now lives once, in the npm package. What remains in `.har/` is
either **yours** or **managed**, and the boundary is explicit:

| Yours | Managed by HAR |
|-------|----------------|
| `harness.env` — pure schema-validated config | Six 35-line shims (`launch.sh`, `verify.sh`, …) that `exec har env <kind>` |
| `stages.json` + `stages/*.sh` — registered verification stages | Stock stage helpers (`readiness.sh`, `lib/verify-runner.mjs`) |
| `hooks/*.sh` — lifecycle side effects | `manifest.json` — versions, migration history, drift checksums |
| Infra templates (compose, PM2 ecosystem) | Docs and agent guidance (`README.md`, `STAGES.md`) |

Customization has exactly five sanctioned homes: config values, registered
stages, lifecycle hooks, plugins (including local ones via `har plugin create`),
and — for people who genuinely want to own the runtime — an explicit
`har env eject` instead of the old silent degraded mode. `har env doctor`
validates the whole contract in one command.

The migration from pre-1.0 is `maintain`-driven: `har env maintain` detects the
old shape and writes a plan plus a `MIGRATE-PROMPT.md` without changing
anything; `--migrate` performs the mechanical rewrite with backups; the prompt
tells a coding agent (or you) how to lift what can't be moved mechanically; and
`--finalize` records the result. Versioned migrations mean 1.0 → 1.1 will
reuse the same machinery.

## What the dogfood caught

We used this repository's three real harnesses — the CLI harness at `.har/`,
Mission Control's at `control/.har/`, and the docs site's at `docs/.har/` — as
the release gate: migrate all three with the real flow, no hand-editing, and
file every manual step as a bug. That single exercise caught six migration-flow
bugs (stock files never installed, `auto` ecosystem resolving to a placeholder,
hooks not receiving config, per-slot database schema silently dropped, and
more) and two release blockers:

**Plugin templates still referenced the retired machinery.** Every plugin's
stage template sourced `agent-slot.sh` — a file that no longer exists on a 1.0
harness. A fresh plugin install would have broken at source time. All templates
were rewritten to the 1.0 stage surface, and the release gate now asserts no
template references retired machinery.

**A stale CLI turned the shims into a fork bomb.** This one took the dev
machine down. Twice. A pre-1.0 `har` treats `.har/verify.sh` as the
authoritative implementation and executes it; the 1.0 shim execs back into
`har`; a pre-1.0 `har` executes the script again — one new process per cycle,
forever. We measured 2,306 stacked processes and a load average of 215 before
pulling the plug. Every shim now carries a re-entry guard (an environment
marker that survives `exec` and aborts the loop on its first cycle with clear
upgrade instructions) and a version floor that skips binaries older than the
harness's pinned runtime.

## What we learned

**Dogfood the migration, not the feature.** Unit tests told us the migration
functions worked. Only migrating three real, adapted, differently-shaped
harnesses told us what the flow *forgot* — and every bug it found is now a
permanent assertion in the release gate.

**Old binaries meet new files — always.** The fork bomb existed precisely in
the version skew window every real user passes through. If two components can
delegate to each other across versions, the loop case needs a guard on day one,
not after the incident.

**Legacy conventions get one home: the migration.** Pre-1.0 `harness.env`
files used the shell no-op `true` as a "not configured" placeholder for command
values. The tempting fix was a special case in the runtime; the right fix was
normalizing the sentinel to `""` once, at migration time, and keeping the
runtime free of magic values.

**Delete contracts nobody consumes.** The verify shim initially preserved a
JSON-on-stdout contract from pre-1.0. Auditing the callers showed nothing
consumed it anymore — so the shim now emits human output and `--json` is
opt-in, which is what the docs had said all along.

**Tests live where the behavior lives.** The bugs were fixed in the package;
the *proof* lives in a registered stage of the repo's own harness — exactly the
extension point 1.0 gives every project. The release gate eats the dog food.

## The numbers

On this repository's main harness, the migration took `.har/` from 2,010 lines
of shell (812 of them runtime machinery) to 940 — of which 695 are our own
end-to-end gate stage and 210 are the six managed shims. Machinery lines
remaining: zero. Same story on the other two harnesses, and
`har env doctor` is green on all three.

If you're on a pre-1.0 harness, the [migration guide](/docs/guides/migrating-to-1-0/)
walks the same path we took — and `har env maintain` will hand you the prompt.

The configuration surface is this page. [The factory line](/blog/the-factory-line/)
is the method: why the unit of work is a station, how the gate only ever adds
assertions, and what it missed because nobody thought to ask.
