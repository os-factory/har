---
name: factory-line
description: Factory line for executing one station of a declared multi-station program — read the installed line bundle (har line status), plan parallel work into isolated HAR slots, run the cumulative gate with har line gate, and hand off for human review. Use when asked to "run a factory line", "run the next station", "execute a milestone program", or when a repo has an installed line and you need to advance it. Not limited to the HAR v1.0.0 migration.
---

# Factory line

Execute **one station** of a declared program end-to-end:

sync → wave plan → parallel slots → cumulative gate → human handoff.

The program lives in an **installed line bundle**, not in this skill. Find it
with `har line status`: installed lines live at `.har/lines/<id>/line.json` and
are recorded in `.har/lines.json`. This skill is the orchestrator;
station-specific how-to lives in other skills the program lists.

`*.line.json` files under `examples/` are **authoring templates**, not the
installed program. Read one to learn the shape or to seed a new bundle
(`har line create <id>`); do not run a station off a loose file when a line is
installed.

**HAR already has the primitives.** Work units, isolated slots, stages with
quick/full tiers, validation records, the commit gate, plugins, Mission Control.
A line is composition plus a manifest. Do not invent a second runner, a
stack-specific MCP tool, or GitHub-shaped stations.

Contract: [LINE.schema.md](./LINE.schema.md).
Instances: [examples/](./examples/).

## Inputs

Resolve these before doing anything (ask only if not inferable):

1. **Line** — run `har line status` (or MCP `har_line_status`). One installed
   line: use it. Several: ask which. **None installed**: stop and offer
   `har line create <id>` (scaffold) or `har line add <spec>` (install a
   published bundle, e.g. `github:os-factory/har-line`). Authoring templates
   live in `examples/`: `v1-milestone.line.json`, `new-plugin.line.json`,
   `docs-milestone.line.json` — seeds, not installed programs.
2. **Station id** — default: the first station whose bound work is not all
   closed / whose gate has not passed. Must be an id in `stations[]`.
3. **Slot budget** — how many concurrent HAR slots you may occupy (check
   `har env status` first). One slot per concurrent agent. Occupied slots
   always block — that is a feature.

If the user says "run the next v1 milestone", load `examples/v1-milestone.line.json`
and prefer the existing [`v1-milestone`](../v1-milestone/SKILL.md) playbook for
station tactics (it remains the executable instance until 1.0 ships). This
skill still owns the loop.

## What this skill must not bake in

These showed up on the HAR 1.0.0 line. They are **instance tactics**. If the
template does not declare them, do not do them:

- GitHub issues as the unit of a station (use `stations[].work`)
- Stacked PRs / a long-lived integration branch
- A named fixture repo (car-app) or `HAR_FIXTURE_MILESTONE=M0..M5`
- "One issue = one PR = one slot"
- Assuming the product of the line is a HAR migration

## Phase 0 — Load and preflight

1. `har line status [id]` and read the program it names
   (`.har/lines/<id>/line.json`). Confirm `contractVersion`,
   `gate.cumulative === true`, `handoff.autonomousShip === false`. The status
   output already reports which stations are green and which is next.
2. **Skills.** For each root `skills[]` entry, confirm the skill is present
   (repo path or the agent's skill list). HAR does not install third-party
   packs — if `install` is an upstream URL, tell the user how to install it.
   Missing optional skills: skip those station steps and say so.
3. **MCP.** For each `mcp[]` entry with `required: true`, confirm the server
   is available. If a required server is missing, stop. If `required: false`,
   skip tracker-dependent steps (issue comments, PRs) and keep the rest.
4. **Plugins / extra stages.** Note what the gate needs. Do not `add-plugin`
   unless the user asked and the template lists it.
5. Pick the station. Print: line id, station id, waves, slot plan, gate stages
   that will run (every `gate.stages[]` whose `fromStation` is this station
   **or an earlier one**).

## Phase 1 — Wave plan

Print the wave plan from `stations[].waves` (or a single cell if `waves` is
omitted). For each group: work id, suggested branch, HAR slot, stack notes
**only if the template's `prototypeNotes` say this line stacks PRs**.

Adjust for work already done. Never share a slot between two concurrent groups.

## Phase 2 — Execute waves

For each wave, spawn **one subagent per group, in parallel**. Each subagent:

1. Checks the slot is free (`har env status`). Occupied → complete/teardown
   that slot first, or pick a free slot in budget. Never share.
2. Launches from the intended base:
   `har env launch <slot> --work-id <workId> --work-source <work.source> --work-url <url> --work-title <title>`
   when work is bound. Skip tracker flags when `work.source` is `none`.
3. Edits **only** in the returned work dir.
4. Follows station skills listed on the station / line.
5. Runs full verify in-slot until green. If this station made a new gate
   question askable, extend the **cumulative** gate (add a stage / assert
   tagged from this station). Never remove an earlier station's stages.
6. Reports back: branch, commits, verify result, deviations. Subagents never
   push, PR, complete, or teardown on their own.

The orchestrator reviews, resolves cross-branch conflicts, and only then
starts the next wave.

## Phase 3 — Gate

From a slot launched off the integrated result of this station:

```bash
har line gate <station> --line <id> --agent <slot>
```

That runs every gate stage whose `fromStation` ≤ current station — the
cumulative set, from data, through the normal stage runner. Pass `--force`
when the program sets `gate.optInEnv` and you want the opt-in jig to run
anyway.

Line gate stages are deliberately **not** part of `har env verify --full`.
Run both: full verify for the harness contract, `har line gate` for the
station.

Red gate → fix in-station, re-run. Never hand off a red gate. Never bypass
(`HAR_SKIP_GATE`, `--no-verify`).

The prototype of a real-product gate (not mocks) is this repo's
`.har/stages/fixture-e2e.sh`: freshly built CLI, clone of a real repo, two
modes (adapted harness + fresh `env init`), opt-in so routine verifies stay
fast. Copy the *properties* when a line needs a jig; do not copy car-app
paths or the `milestone_asserts` `case`.

## Phase 4 — Traveler and handoff

Update the `traveler` the template names (issue comment, ledger file, PR
body). The traveler has to survive this repo's merge policy — squash-merge
drops per-commit `BREAKING CHANGE:` footers.

Then **stop and wait**. Do not merge, push to the default branch, complete a
slot, or release. Present a session handoff (summary, session branch, preview
URLs, gate evidence).

## Growing the ratchet

A gate only tests the questions you thought to ask. After six green
milestones, HAR 1.0 still missed #291 (shim × stale CLI fork bomb),
#297/#299 (scripts migrated, prose and `attach.sh` did not), and #298 (CI
tested the published pre-1.0 package). When a review finds a new class of
defect, add a stage or `doctor` question and tag it onto the line — that is
how the ratchet earns the next station.

See [LINE.schema.md](./LINE.schema.md) "Growing the ratchet."
