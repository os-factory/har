---
name: v1-milestone
description: Factory line for executing one milestone of the HAR v1.0.0 refactor (epic os-factory/har#225) — plan the wave of parallel subagents, implement each issue in its own HAR slot, ship stacked PRs, run the fixture-e2e milestone gate, and hand off for review. Use when asked to "run the next v1 milestone", "work on v1.0.0", "execute M0/M1/…", or "run the milestone gate".
---

# HAR v1.0.0 milestone factory line

Execute one milestone of the v1.0.0 refactor end-to-end:
sync → wave plan → parallel implementation → stacked PRs → gate → handoff.

**Source of truth is GitHub**: epic [#225](https://github.com/os-factory/har/issues/225)
and its sub-issues #226–#243 (plus triaged bugs #195–#198). Never duplicate the
plan into files; report progress as issue comments and epic checkboxes.

Input: a milestone id `M0..M5` (default: the first milestone whose issues are
not all closed).

## Milestone map

| Milestone | Issues | Waves (each `{}` group = one subagent; groups in a wave run in parallel) |
|---|---|---|
| **M0** Foundations + 0.x patches | #226 #227 #228 #229 #196 #197 #198 + #195 (skip-ci half only) | Wave 1: {#228} {#196} {#197} {#198} {#195} · Wave 2: {#226} · Wave 3: {#227} {#229} |
| **M1** Contract | #230 #231 #232 #233 | Wave 1: {#230} {#233} · Wave 2: {#231} · Wave 3: {#232} |
| **M2** Runtime into package | #234 #235 #236 | Wave 1: {#234} split into parallel forks per module (ports/preflight, worktree+launch, provisioning, infra, slot-registry) + one integration fork · Wave 2: {#235} {#236} |
| **M3** Adaptation & extensibility | #237 #238 #239 #240 | Wave 1: all four in parallel · Wave 2: integration pass |
| **M4** Migration & docs | #241 #243 | Wave 1: both in parallel |
| **M5** Release gate | #242 + the `v1` → `main` release PR | Sequential; ends in handoff for the 1.0.0 release decision |

Waves are ordered by real file conflicts: #226 rewrites the template tree, so
#227/#229 (and anything touching `src/templates/`) must stack on top of it;
#231 needs #230's env schema; #232 validates both.

## Phase 0 — Sync

1. `gh issue view 225` + `gh issue list --milestone 1.0.0 --state all` — determine
   milestone state; confirm (or take as argument) which milestone to run.
2. **Integration branch**: all v1 work lands on the long-lived `v1` branch, never
   directly on `main`. Assert the main checkout is on `v1`, clean, and up to date
   (create it from `main` if it does not exist yet: `git checkout -b v1`) —
   `har env launch` bases every session worktree on the main checkout's current
   HEAD, so this is what makes every slot build on `v1`.
3. Preconditions: `npm run build` succeeds;
   Docker running **only if** Mission Control (`har control up`) is wanted — the
   fixture itself is SQLite and needs no Docker.
4. Re-read each issue in the milestone: bodies carry file:line references,
   task checklists, and acceptance criteria from the architecture audit.

## Phase 1 — Wave plan

Print the wave plan for the chosen milestone (from the map above, adjusted for
issues already closed). For each group note: issue, branch name
(`v1/<issue#>-<slug>`), stack position, HAR slot to use (1–5, one per
concurrently running subagent, checked free via `har env status`).

## Phase 2 — Execute waves

For each wave, spawn **one fork subagent per group, in parallel** (single
message, multiple Agent calls, `subagent_type: "fork"`). Each fork:

1. Launches its assigned slot from the milestone stack base:
   `har env launch <slot> --work-id <issue#> --work-source github --work-url <issue url>`.
   Occupied slot → `complete`/`teardown` first (never share slots between forks).
2. Edits **only** in the returned work dir; follows the issue's task checklist
   and acceptance criteria.
3. Conventional commits referencing the issue (`fix: … (#196)`,
   `feat!: … (#234)`). Breaking-change commits are fine on `v1` — semantic-release
   only runs on `main` (`release.config.cjs`), so 1.0.0 is cut exactly once, by
   the final `v1` → `main` merge in M5.
4. Runs full verify in-slot until green; extends `.har/stages/fixture-e2e.sh`'s
   `milestone_asserts` case when the issue makes a pending assert implementable
   (e.g. #232 → M1 doctor checks, #235 → M2 shim parity, #241 → M4 migration).
5. Reports back: branch, commits, verify result, deviations. Forks never push,
   PR, complete, or teardown on their own.

The orchestrator reviews each fork's branch, resolves cross-branch conflicts
itself, and rebases branches into the milestone stack order.

## Phase 3 — Stacked PRs

- One branch/PR per issue. Bottom PR bases on **`v1`** (never `main`); every
  other PR bases on its predecessor:
  `gh pr create --base <prev-branch> --head <branch>`.
- PR body: `Closes #<issue>`, stack position (`Stack 2/4 — based on #<prev PR>`),
  gate status, and the standard footer:
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- After Antoine merges the bottom PR into `v1`: retarget the next PR to `v1`
  (`gh pr edit --base v1`) and rebase the remainder
  (`git rebase --onto v1 <old-base> <branch>`).
- Keep `v1` current: after upstream `main` moves (0.x patches), merge `main`
  into `v1` before starting the next milestone.

## Phase 4 — Milestone gate

From the **top of the stack** (a slot launched off it):

```bash
npm run build && npm test
HAR_FIXTURE_E2E=1 HAR_FIXTURE_MILESTONE=<M#> har env verify <slot> --full
```

Full verify runs typecheck/build/docs/tests/lint/docs-drift **plus
`fixture-e2e`**, which clones `/home/antoine/Documents/osfactory/examples/car-app`
into `~/.har-fixtures/` and drives the freshly built CLI through
maintain → launch → full verify (incl. Playwright) → status → complete on the
adapted harness, plus a fresh `env init` lifecycle, plus the milestone's
asserts. Because it runs through `har env verify`, the gate is recorded in
`.har/runs/` and visible in **Mission Control** (`har control up` if not
running).

Red gate → fix in-stack, re-run. Never hand off a red gate. Never bypass
(`HAR_SKIP_GATE`, `--no-verify`).

## Phase 5 — Handoff (required)

Post a milestone summary comment on #225: PRs in stack order, gate run id +
result, fixture evidence (from `.har/artifacts/fixture-e2e/`), deviations.
Then **stop and wait for Antoine's review** — never merge, push to `main`,
or release autonomously. 1.0.0 is cut only by the final M5 `v1` → `main`
release PR he approves — merged as a **merge commit** (not squash) so
semantic-release reads the individual `feat!:`/`feat:`/`fix:` commits; if
squashed instead, the squash message must carry the `BREAKING CHANGE:` footer.

## Safety rails

- The fixture source repo is **never** modified — clones only
  (`~/.har-fixtures/car-app*`), remotes scrubbed to `invalid://scrubbed`.
- Never print a repo's remote URL (`git remote -v`) in logs — remotes can embed
  credentials.
- One HAR slot per concurrent fork; occupied slots always block.
- All the usual dogfood rules from `.har/README.md` apply.
