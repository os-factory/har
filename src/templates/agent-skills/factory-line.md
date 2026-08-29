# Run a factory line

Execute **one station** of a declared multi-station program:

sync → wave plan → parallel HAR slots → cumulative gate → human handoff.

The program lives in a **line template** (a `*.line.json` the user points at,
or `.har/line.json` when that file exists). This workflow is the orchestrator.
Station-specific how-to lives in other skills the template lists.

HAR already has the primitives — work units, isolated slots, stages, plugins,
validation records. A line is composition plus a manifest. Do not invent a
second runner, a stack-specific MCP tool, or GitHub-shaped stations.

This workflow is the same on Claude Code (`/factory-line`), Cursor
(`.cursor/commands/factory-line`), and Codex (`har-factory-line`).

## Inputs

Resolve these before doing anything (ask only if not inferable):

1. **Line file** — path to a `*.line.json`. If the repo has no line file and
   the user did not name one, stop and say so. Do not invent GitHub issue
   numbers or a fixture repo.
2. **Station id** — default: the first station whose bound work is not all
   done / whose gate has not passed.
3. **Slot budget** — `har env status` first. One slot per concurrent agent.
   Occupied slots always block.

## Contract (minimum)

A line file is JSON with `contractVersion: 1`. Required:

- `id`, `stations[]` (ordered; each has `id` + `title`)
- `gate.cumulative` must be `true`
- `handoff.autonomousShip` must be `false`

Optional: `skills[]` and `mcp[]` (declarations + install hints — HAR does not
vendor third-party skill packs or add core MCP tools), `plugins[]`,
`gate.stages[]` with `fromStation` (that stage stays required from this
station **on**), `extraStages[]`, `traveler`, `stations[].work` / `waves`.

`work.source` is `github`, `linear`, `none`, or a free string — the tracker
is data on the station, not the type of the station. If `waves` is omitted,
the station is one sequential cell.

A QA station is never removed. Adding a station must not drop earlier
`gate.stages`. When a review finds a new class of defect, add a stage or
doctor question and tag `fromStation` — that is how the ratchet grows.

## What this workflow must not bake in

Stacked PRs, a long-lived integration branch, a named fixture repo, `M0..M5`,
and "one issue = one PR = one slot" are **instance tactics**. If the template
does not declare them, do not do them.

## 0. Load and preflight

1. Read the line file. Confirm `gate.cumulative` and `handoff.autonomousShip`.
2. Skills and MCP: confirm required ones are present. Missing optional:
   skip those steps and say so. Do not install third-party packs yourself.
3. Print: line id, station id, waves, slot plan, and every gate stage whose
   `fromStation` is this station or an earlier one.

## 1. Wave plan

Print `stations[].waves` (or a single cell). One HAR slot per group in a
wave. Never share a slot between two concurrent groups.

## 2. Execute waves

For each wave, one subagent per group, in parallel. Each:

1. Checks the slot is free. Occupied → complete/teardown that slot, or pick
   a free slot in budget.
2. `har env launch <slot>` with `--work-id` / `--work-source` / `--work-url`
   / `--work-title` when work is bound. Skip tracker flags when source is
   `none`.
3. Edits **only** in the returned work dir.
4. Full verify in-slot until green. If this station made a new gate question
   askable, add it — never remove an earlier station's stages.
5. Reports back. Subagents never push, PR, complete, or teardown on their own.

## 3. Gate

Run every gate stage whose `fromStation` ≤ current station. If
`gate.optInEnv` is set, export it as `1` so the opt-in jig actually runs.

Red gate → fix, re-run. Never hand off a red gate. Never bypass
(`HAR_SKIP_GATE`, `--no-verify`).

## 4. Handoff

Update the `traveler` the template names. Then **stop and wait**. Do not
merge, push to the default branch, complete a slot, or release. Present a
session handoff (summary, session branch, preview URLs, gate evidence).
