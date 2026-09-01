---
title: The factory line
description: How we ran HAR 1.0.0 as a software factory — stations, a ratchet, and the questions the gate never asked.
date: 2026-08-27
kicker: Method
---

A harness is a manufacturing word. It is a jig: something that holds a unit in a known state so you can measure it. HAR already named that. Shipping 1.0.0 was the rest of the factory — stations in sequence, identical workstations, a QA gate on a real unit, a traveler that survives the merge policy, and a human on the andon cord.

What 1.0.0 *is* — `.har/` as a configuration surface, what broke, how to migrate — is [HAR 1.0.0](/blog/har-1-0-0/). This piece is the method we used to get there.

Two skills in this repository already call themselves a factory line: `v1-milestone`, which ran the 1.0.0 refactor, and `new-plugin`, which ships a verification plugin from research to a pull request. Those are unrelated jobs. They converged on the same shape. That is evidence the metaphor is load-bearing, not a slide.

## Where the analogy holds — and where it breaks

An analogy that admits its limits reads as thinking.

| Holds | Breaks |
| --- | --- |
| Stations in sequence; identical HAR slots as workstations; parallel cells; a QA gate; poka-yoke; jidoka; a traveler; an andon cord | **Identical units out the door** — the line repeats the *process*, never the product. Every program is bespoke. |
| | **Rework = waste** — iteration is the expected mode, not a defect. |

M0 through M5 were stations. A HAR slot is the strongest fit in the table: an identical workstation, isolated, reusable. Occupied slots block, the commit gate refuses an unproven tree, and `doctor` refuses a broken contract — poka-yoke. The gate can stop the line (jidoka; later, exit 86). Nothing merges without a go-ahead.

What the analogy will not do is pretend the output was interchangeable parts. The line repeats a process. The product of each station was a different slice of a refactor. And rework was not waste: iteration was how the stations ran.

## The unit of work is a station, not a task

Epic [#225](https://github.com/os-factory/har/issues/225) started from a number, not a vibe. Pre-1.0, `har env init` copied the runtime into every project. Across three boilerplate profiles that was roughly 8,800 lines of template, about 2,400 of them byte-identical duplicates. One node-PM helper block was copied seven times. Twenty files landed in an installed harness; the target was about seven.

"Let an agent refactor this" fails without a line for the same reason a factory does not hand a whole plant to one person with a punch list. The work has file conflicts, ordered dependencies, and a quality bar that has to hold after every station, not only at the end. An agent given the epic as a task will either serialize everything — and stall — or parallelize without isolation — and collide. A station is a named step with a workstation, a gate, and a handoff. A task is a sentence.

## The workstation

HAR already had the workstation: an isolated slot — its own worktree, ports, and environment. "Occupied slots always block" is the feature that makes N parallel agents safe. Sharing a slot across unrelated chats is how you get two writers on one tree. The line treated that as poka-yoke, not ceremony. Each concurrent station got its own slot; an occupied slot meant complete or teardown first, then launch.

Identical workstations are why a wave of subagents could run without inventing a new isolation story per issue.

## The jig

The gate was not a mock. `fixture-e2e` cloned a real repository — car-app, Next.js and SQLite, default profile, Playwright plugin — and ran the freshly built CLI against it in two modes: (1) an already-adapted harness through maintain → launch → full verify → complete, and (2) a fresh `env init` and a full slot lifecycle. The source repo was never touched.

It is opt-in (`HAR_FIXTURE_E2E=1`) so routine verifies stay fast. A jig you run on every keystroke stops being a jig; it becomes the bottleneck. The line ran it when a station claimed to have moved the contract.

## The ratchet

This is the piece most refactor write-ups do not have.

`HAR_FIXTURE_MILESTONE=M0..M5` does not swap assertions. It **adds** them. M1 still runs M0. M5 still runs M0. A QA station, once installed, is never removed.

That sounds small. It is the difference between a checklist you edit down as you get tired and a line that only ever tightens. Most milestone gates replace the old questions with the new ones, which is how you ship a later station that silently regresses an earlier one. The ratchet makes that a fail: the new work still has to pass the old stations.

The implementation in this repository is a `case` in `.har/stages/fixture-e2e.sh`. That is a prototype, not the product. The invariant is the cumulative gate.

## The traveler

The epic was the traveler — the card that rides with the unit. On it we kept a breaking-changes ledger, as a comment, because squash-merge drops per-commit `BREAKING CHANGE:` footers. Semantic-release never sees them. The ledger comment is the only durable record of what actually broke.

A line has to survive the merge policy the repository actually has, not the one the process diagram wished for.

## The andon cord

Agents hand off. They do not ship. Every merge waited on a human go-ahead. That is the andon cord: anyone can stop the line; nobody on the line pulls the release.

The session contract in this repository says the same thing in tooling language — present a handoff, then wait. Complete, push, and open a pull request are approval steps, not agent steps. A factory that lets the station ship the unit is not a factory. It is an unsupervised pipeline.

## What the line caught, and what it missed

Dogfooding the migration on this repository's three real harnesses found six flow bugs and two release blockers before users would have. Those are now assertions. This section is about the misses — defects that showed up in a pre-release review after six green milestones.

**[#291](https://github.com/os-factory/har/issues/291) — a stale global `har` and the 1.0 shims.** Pre-1.0 `har` treats `.har/verify.sh` as the implementation and executes it. The 1.0 shim `exec`s back into `har`. A pre-1.0 binary executes the script again. One new process per cycle, forever. We measured 2,306 node processes and a load average of 215. It took the machine down twice. The fix is a re-entry guard (exit 86) and a version floor that skips binaries older than the harness's pinned runtime. The gate never asked "what if the `har` on `PATH` is from last month?"

**[#297](https://github.com/os-factory/har/issues/297) / [#299](https://github.com/os-factory/har/issues/299) — scripts, not prose.** The line migrated scripts, `harness.env`, and stages. It did not migrate the words agents read. `attach.sh` still sourced `agent-slot.sh`, a file the same migration deleted. The dogfood READMEs still indexed retired machinery. `doctor` reported PASS. Drift treated the READMEs as user-adapted, so it would not revert them. The gate never asked whether the prose still described the files on disk. `doctor` now does.

**[#298](https://github.com/os-factory/har/issues/298) — CI against the published package.** The Mission Control job invoked the new shims without putting this repository's freshly built CLI on `PATH`. The shims fell through to `npx @osfactory/har@0.64.1` — the last published release, which predates the 1.0 runtime. The job was testing the new harness surface against the old package. The re-entry guard did its job (exit 86). The question "does CI run the code under test?" had not been on the ratchet.

The honest lesson: **a gate only tests the questions you thought to ask.** A ratchet that cannot grow is just a freeze. The misses are now questions. That is the point of a line you keep.

## Making it a product

None of this requires a rewrite. Isolated slots, stages with tiers, validation records, the commit gate, hooks, plugins, work-unit binding, skills, MCP — HAR 1.0 already has the primitives. A factory line is composition: an ordered set of stations, each runnable by one or more agents in isolated slots, with a cumulative gate, and a handoff a human owns.

That work lives in [#302](https://github.com/os-factory/har/issues/302). It is post-1.0.0 on purpose. 1.0 ships the primitives; the line composes them. What comes next is a parameterized skill and a template contract — not a new orchestrator, and not a promise about Mission Control boards or a `har line` command. This post does not wait on those.

The method already ran. The product is whether the next program — a plugin line, a migration line, something that is not HAR itself — can declare the same shape without forking `v1-milestone`.
