---
title: Factory lines
description: Declare a repeatable multi-station program — skills, MCP, and cumulative gate stages — without forking a playbook.
---

A **factory line** is a declared program: an ordered set of stations, each
runnable by one or more agents in isolated HAR slots, with a **cumulative**
gate and a handoff a human owns.

HAR already has the primitives — work units, slots, stages, plugins,
validation records, the commit gate. A line is **composition plus a
manifest**, not a new runner.

A line ships as an **installable bundle**, the same way a verification plugin
does: `line.manifest.json` at the package root, installed from a path, git
repo, npm package, or a bundled id. The difference is the apply path.

> **Installing a line never widens verify.** `har line add` registers the
> line's stages in `.har/stages.json` but does **not** add them to
> `verificationStages`. Default `har env verify --full` takes exactly as long
> as it did before. If a check should gate *every* verify, ship it as a
> [verification plugin](/docs/guides/plugins/) instead.

## Install one

```bash
har line add github:os-factory/har-line   # git
har line add ./my-line                    # local path
har line add @acme/onboarding-line        # npm
har line status                           # stations and gate progress
har line gate S2 --line my-line           # run the cumulative gate
```

`har line create <id>` scaffolds a publishable bundle at `.har/lines/<id>/`
(manifest, program, an off-verify gate stage, README). Installs are recorded
in `.har/lines.json`.

[`os-factory/har-line`](https://github.com/os-factory/har-line) is the GitHub
template for authoring one — the line equivalent of
[`os-factory/har-plugin`](https://github.com/os-factory/har-plugin).

Two skills in this repository already described themselves as a factory line
before the name was a product:

- `v1-milestone` — one milestone of the 1.0.0 refactor
- `new-plugin` — research, template, register, validate on a real repo, PR

Those are **instances**. The orchestrator is the `factory-line` skill at
`.claude/skills/factory-line/` in this repository. Do not copy `v1-milestone`
and edit issue numbers.

## The unit of work is a station

A station is a named step with optional work-unit binding, a slot policy, and
a gate. How work is tracked (GitHub, Linear, nothing) is data on the station,
not the type of the station.

Identical isolated slots are the workstation. One slot per concurrent agent;
**occupied slots always block** — that is what makes N parallel agents safe.

## Author a line

1. `har line create <id>`, or "Use this template" on
   [`os-factory/har-line`](https://github.com/os-factory/har-line).
2. Fill `id`, `stations[]`, `skills[]`, `mcp[]`, `gate`, `handoff`, `traveler`
   in `line.json`. The contract is in
   `.claude/skills/factory-line/LINE.schema.md`; close instances are under
   `.claude/skills/factory-line/examples/`.
3. Keep `gate.cumulative` true and `handoff.autonomousShip` false.
4. Put instance tactics (stacked PRs, a specific fixture, tracker-only
   stations) in `prototypeNotes` — not in the orchestrator skill.
5. `har line add <id>` to install it, then run the `factory-line` skill with a
   station id.

### Attach a skill

Root `skills[]` are what the line expects. Station `skills[]` are extra
playbooks for that step. HAR does **not** install or copy third-party skill
packs ([skill-pack compatibility](/docs/guides/skill-pack-compatibility/)).
`install` is a hint (`repo:…`, an upstream URL). The agent or a human installs;
Phase 2 can have `doctor` check presence.

### Declare MCP

List MCP **servers** the line needs (`github`, `linear`, a product MCP) and
why. Lines declare MCP; they do not add stack-specific tools to HAR core.
*Plugins install stages; agents only talk to the stage registry.* If a server
is `required: false`, skip tracker steps when it is missing.

### Add a testing / gate stage

`gate.stages[]` tags **existing** registered stages (`stages.json`) with
`fromStation`. From that station on, the stage stays in the gate. That is the
**ratchet**: a QA station is never removed.

`extraStages[]` is for checks the profile does not already have (a
fixture-e2e analogue, a docs-drift rule, a `doctor` question). The bundle's
`stages[]` register them at install time — registered and runnable, and still
absent from `verificationStages`. Prefer tagging a stage that already exists.

Routine verifies should stay fast. If the jig is expensive, set
`gate.optInEnv` (this repo uses `HAR_FIXTURE_E2E=1`).

### Grow the ratchet

A gate only tests the questions you thought to ask. After six green
milestones, the 1.0 line still missed a shim × stale-CLI fork bomb (#291),
scripts-vs-prose drift (#297, #299), and CI testing the published pre-1.0
package (#298). When that happens:

1. Add a stage or a `doctor` check that asks the new question.
2. Tag `fromStation` on the station that made it askable.
3. Leave every earlier tag in place.

The bash `case` in `.har/stages/fixture-e2e.sh` was the **prototype** of this
pattern, not the product: later milestone arms there add questions but do not
always re-enter earlier arms. `har line gate <station>` is the productized
version — it runs every stage tagged at that station or earlier, from data, so
the set can only grow.

## Instances

| Line file | What it proves |
|---|---|
| `examples/v1-milestone.line.json` | The contract can express the 1.0.0 run (waves, GitHub work, opt-in real-repo gate, traveler on an epic). |
| `examples/new-plugin.line.json` | Same contract, sequential phases, optional MCP, a real-repo jig that is not car-app. |
| `examples/docs-milestone.line.json` | Empty tracker, no stacked PRs, gate is tagged existing stages only. |

If a field is required to express `docs-milestone` that only exists because of
the v1 migration, the contract is still biased — delete it.

## What a line is not

| Not this | Because |
|---|---|
| A verification plugin | Plugin stages join `verificationStages` and gate every verify. Line stages never do. A line also *references* plugins by id. |
| A fourth marketplace | Lines reuse the plugin install channels (path, git, npm) and the plugin resolver. |
| A second stage runner | `har line gate` runs stages through the same runner and writes the same `.har/runs/` records. |
| A new MCP surface | No `har_run_playwright`. No tracker-named core tools. |
| Identical units out the door | The line repeats the *process*. Every program is bespoke. |
| Rework as a defect | Iteration is the expected mode. |

Agents hand off. They do not ship. That is the andon cord.

## Poka-yoke

The two bundle kinds are deliberately not interchangeable:

- `har env add-plugin` on a line bundle fails and points at `har line add`.
- `har line add` on a plugin manifest fails and points at `har env add-plugin`.
- A line manifest that declares `verificationStages` is a schema error.
- `har line add` re-reads the verify plan after applying and refuses to write
  if it moved.
- `har env doctor` fails when a line stage appears in `verificationStages` —
  so a hand edit is caught before the next launch.

## Next

Mission Control gets a line board over `.har/lines.json` and `har line status`
([#305](https://github.com/os-factory/har/issues/305)).
