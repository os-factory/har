---
title: Customization contract
description: The four sanctioned ways to make a harness yours — config, stages, hooks, and plugins — plus eject for full ownership.
---

`.har/` is a configuration surface. The machinery — worktrees, ports, toolchain
provisioning, the slot registry, the verification runner — lives once, in the
HAR package, behind thin `./.har/*.sh` shims. What the repository owns is its
**behavior**, and every kind of behavior has exactly one sanctioned home:

| You want to change… | Put it in | Docs |
| --- | --- | --- |
| A setting: ports, services, commands, limits | `harness.env` (schema-validated config) | [Environment variables](/docs/reference/environment/) |
| A verification step | A registered stage in `stages.json` (+ script in `.har/stages/`) | [Stages & artifacts](/docs/guides/stages/) |
| A side effect at launch/verify/teardown time | A lifecycle hook in `.har/hooks/` | [Hooks](#lifecycle-hooks) |
| Anything bigger — a reusable integration | A plugin (bundled, npm, git, or local in `.har/plugins/`) | [Plugins](/docs/guides/plugins/), [Local plugins](/docs/guides/local-plugins/) |
| The runtime itself | `har env eject` — explicit script ownership | [Eject](/docs/guides/eject/) |

Everything in that table is in-repo, reviewable, drift-tracked as *yours*, and
survives `har env maintain` upgrades. What is **not** sanctioned is patching the
generated shims or the packaged runtime's behavior by hand — that is what
`eject` exists for.

## Configuration — `harness.env`

Pure `KEY=value` configuration validated against a schema: primary app,
infra services, port lanes, migrate/seed commands, health check path, slot
limits. No shell functions, no logic. `har env doctor` reports unknown keys and
schema violations.

## Stages — verification as data

`stages.json` is the single registry of everything the harness can run and
verify. `verificationStages` lists the pipeline; each stage carries a
`tier` (`quick` or `full`). One-liner checks are command stages; checks that
need the slot's env, ports, or artifacts get a script in `.har/stages/` or a
[local plugin](/docs/guides/local-plugins/). Never edit `verify.sh` — it is a
shim over the packaged runner.

## Lifecycle hooks

Executable scripts in `.har/hooks/` run at fixed points:

`pre-launch.sh` · `post-launch.sh` · `pre-verify.sh` · `pre-teardown.sh` · `post-teardown.sh`

Hooks receive a stable env contract (`HAR_HOOK_CONTRACT=1`): `AGENT_ID`,
`WORK_DIR`, `ENV_FILE` (once the session has one), `HAR_HARNESS_DIR`, and
`HAR_PORT_<NAME>` for allocated ports. A failing `pre-*` hook aborts the
operation with attribution; `post-*` failures warn by default
(`HARNESS_HOOK_POST_FAILURE=fail` makes them fatal). Hooks are user-owned:
never drift-checked, and `har env doctor` only validates names and
executability.

Rule of thumb: **stages** for anything that verifies (it gets a run record and
a pass/fail); **hooks** for side effects around the lifecycle (warm a cache,
prep fixtures, clean up external resources).

## Plugins

Rich integrations — Playwright, RocketSim, security scanners, your own
db-integrity check — ship as plugins that install stages into the registry.
Sources: bundled with HAR, npm, git, or project-local in `.har/plugins/`
(`har plugin create <id>`). Agents never talk to plugins directly; they only
see the stage registry.

## Validation and drift

- `har env doctor` validates the whole contract: env schema, stage registry,
  script resolution, port lanes, hooks, slot registry — see
  [Doctor](/docs/reference/doctor/).
- Drift is two-signal: files you edited are `user-adapted` (yours, never
  reverted), files whose bundled template moved are `upstream-updated` (apply
  the update), both at once is a `conflict` (merge). `har env maintain`
  drives this.
