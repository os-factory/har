---
title: Migrating to 1.0
description: Upgrade a pre-1.0 harness to the 1.0 configuration surface without breaking your flow.
---

HAR 1.0 moves the harness machinery out of `.har/` and into the package. A
pre-1.0 harness carries ~20 vendored files; a 1.0 harness keeps only what is
yours — config, stages, hooks, plugins, docs — behind thin shims. The migration
is designed so **muscle memory never breaks**: `./.har/verify.sh 1 --full`,
`har env launch 1`, and the MCP tools work the same before, during, and after.

## Nothing breaks on upgrade day

Upgrading `@osfactory/har` does not brick an old harness. Pre-1.0 vendored
scripts keep working against the 1.0 CLI for a compatibility window — you get
loud deprecation warnings, not breakage. Migrate when ready.

## Run the migration

```bash
har env maintain
```

`maintain` detects the pre-1.0 shape (vendored runtime scripts, shell
functions in `harness.env`, legacy port triplets) and drives a versioned
migration:

1. **Mechanical steps run as code.** Every installed file is classified using
   the manifest checksums:
   - **Stock** (never edited) — replaced silently: runtime scripts become
     shims, `harness.env` boilerplate becomes schema'd config.
   - **Adapted** (you edited it) — nothing is overwritten; the customization
     is lifted into the [contract](/docs/guides/customization/) or handed to
     you in the prompt. Machinery still sourced by a surviving script (e.g. a
     stage script that sources `agent-slot.sh`) is retained until you rewrite
     that script against the 1.0 stage surface — the prompt tells you where.
2. **A `MIGRATE-PROMPT.md` is generated** (same pattern as
   `ADAPT-PROMPT.md`) covering only the non-mechanical residue: which adapted
   files carry real customization, where each one lands in the new model
   (config value, registered stage, hook, or local plugin), and a
   verification checklist. Run it with your coding agent.
3. **Finish green:**

   ```bash
   har env doctor
   har env launch 1 && har env verify 1 --full
   ```

4. **Finalize.** Record the migration and clean up the transient artifacts
   (`.har/migrate/`, the prompt):

   ```bash
   har env maintain --finalize --summary "Migrated to the 1.0 config surface"
   ```

## Where old customizations go

| Pre-1.0 customization | 1.0 home |
| --- | --- |
| Edited values/exports in `harness.env` | Schema'd config keys in `harness.env` |
| Shell functions in `harness.env` | Removed — provided by the runtime |
| Patched `verify.sh` steps | Registered stages in `stages.json` / `.har/stages/` |
| `add-stage --custom` scripts | [Local plugins](/docs/guides/local-plugins/) or plain command stages |
| Patched `launch.sh`/`teardown.sh` side effects | [Lifecycle hooks](/docs/guides/customization/#lifecycle-hooks) in `.har/hooks/` |
| Deep runtime patches | [`har env eject`](/docs/guides/eject/) — keep script ownership explicitly |

If the harness is heavily customized and not worth lifting yet, the migration
offers **eject**: you keep working scripts and full ownership, and can adopt
the managed shims later.

## What 1.0 deliberately does not break

- `./.har/launch.sh 1` / `verify.sh 1 --full` / `teardown.sh 1` argument
  conventions — shims stay CLI-compatible.
- `har env …` commands and MCP tool contracts.
- `stages.json` stage entries and existing slot registries.

What it does retire: vendored-script internals, `add-stage --custom`,
`harness.env` shell functions, and single-signal drift (see
[two-signal drift](/docs/guides/customization/#validation-and-drift)).

## What a migrated harness looks like

`har env maintain --migrate` finishes the *mechanical* half. Use this inventory
to confirm the result, and to spot the leftovers it cannot decide for you.

**Should be gone** — the runtime now lives in the package:

```
.har/agent-slot.sh          .har/lib/infra.sh
.har/provision-toolchain.sh .har/lib/node-pm.sh
.har/simulator.sh
```

**Should be a thin shim** — each of these is ~35 lines ending in
`exec har env …`, and nothing else:

```
.har/launch.sh   .har/verify.sh    .har/teardown.sh
.har/preflight.sh .har/agent-cli.sh .har/setup-infra.sh
.har/attach.sh    # pm2 profiles only
```

**Should be yours** — `harness.env`, `stages.json`, `stages/`, `hooks/`,
`plugins/`, `env.template`, `ecosystem.agent.template.cjs`,
`docker-compose.agent.yml`, and the docs.

Confirm all of it in one step:

```bash
har env doctor
```

Doctor fails if any surviving script still loads retired machinery — the exact
trap described below.

### Check your own scripts for retired machinery

The migration deletes the vendored runtime, so **any script of yours that still
sources it breaks the moment someone runs it**. This bit us: HAR's own
`control/.har/attach.sh` shipped through the 1.0 migration still doing
`source "$SCRIPT_DIR/agent-slot.sh"` after the migration had deleted that file.

```bash
grep -rn 'agent-slot\.sh\|provision-toolchain\.sh\|simulator\.sh\|lib/infra\.sh\|lib/node-pm\.sh' .har/
```

Anything that turns up needs rewriting against the 1.0 stage surface. You rarely
need what you were sourcing: stage scripts and hooks already receive `WORK_DIR`,
`ENV_FILE`, `AGENT_ID`, and `HAR_HARNESS_DIR` in the environment, and the slot's
env file is sourced for you.

### Docs are not migrated for you

The migration rewrites scripts and config; it does not rewrite prose. Re-read
your own `.har/README.md` and any repo-level
`AGENTS.md`, and fix anything that still describes the pre-1.0 world — file
tables listing deleted machinery, and especially **the old claim that
`./.har/*.sh` writes no run history**. In 1.0 the shims delegate to the same
runtime, so every entry point writes the same run and validation records and the
commit gate is satisfiable from any surface. Agents read these files as
instructions; a stale table sends them down a path that no longer exists.

### Keep a stale global `har` from fighting your harness

The shims resolve `har` from `PATH` first. If that `har` is older than the
version your harness pins, it does not own these runtime kinds — it executes the
shim as authoritative, which execs back into `har`, and so on. The shims refuse
to take part (exit `86`) rather than fork-bomb the machine:

```
Error: runtime loop detected — the har CLI that ran this shim delegated back into it.
```

The fix is to upgrade the resolved binary — `npm i -g @osfactory/har@latest`, or
`npm i -D @osfactory/har` in the repo. In CI, install or build the runtime and
put it on `PATH` **before** invoking any `./.har/*.sh` step; otherwise the shims
fall through to `npx @osfactory/har@<pinned>` and you are testing against
whatever that resolves to rather than the version you meant.
