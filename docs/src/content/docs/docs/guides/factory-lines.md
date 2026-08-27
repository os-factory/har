---
title: Factory lines
description: Declare a repeatable multi-station program — skills, MCP, and cumulative gate stages — without forking a playbook.
---

A **factory line** is a declared program: an ordered set of stations, each
runnable by one or more agents in isolated HAR slots, with a **cumulative**
gate and a handoff a human owns.

HAR 1.0 already has the primitives — work units, slots, stages, plugins,
validation records, the commit gate. A line is **composition plus a
manifest**, not a new runner. This guide is Phase 1 of
[epic #302](https://github.com/os-factory/har/issues/302): the skill and the
template contract, with no CLI yet. `.har/line.json` and `har line` are Phase 2.

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

1. Copy the contract in `.claude/skills/factory-line/LINE.schema.md` and a
   close instance from `.claude/skills/factory-line/examples/`.
2. Fill `id`, `stations[]`, `skills[]`, `mcp[]`, `gate`, `handoff`, `traveler`.
3. Keep `gate.cumulative` true and `handoff.autonomousShip` false.
4. Put instance tactics (stacked PRs, a specific fixture, tracker-only
   stations) in `prototypeNotes` — not in the orchestrator skill.

Then run the `factory-line` skill with the path to your file and a station id.

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
fixture-e2e analogue, a docs-drift rule, a `doctor` question). Phase 1
documents them; Phase 2 registers them. Prefer tagging a stage that already
exists.

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

The bash `case` in `.har/stages/fixture-e2e.sh` is the **prototype** of this
pattern, not the product. Later milestone arms there add questions; they do
not always re-enter earlier arms. Phase 2 should make "run every stage tagged
≤ current station" data on the stage registry.

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
| A new plugin kind | Plugins already install stages. A line *references* plugins. |
| A new MCP surface | No `har_run_playwright`. No tracker-named core tools. |
| Identical units out the door | The line repeats the *process*. Every program is bespoke. |
| Rework as a defect | Iteration is the expected mode. |

Agents hand off. They do not ship. That is the andon cord.

## Next

Phase 2 will lift the template into `.har/line.json` and `har line status`,
with the ratchet as tagged stages. Until then this guide and the skill are
the whole feature — cheap on purpose, so the shape gets used before anyone
invents CLI surface.
