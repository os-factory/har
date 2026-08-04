# SWE-bench HAR setup

Repository: {{repo}}
Instance: {{instance_id}}
HAR profile: {{har_profile}}

## Benchmark context

`har env init --profile {{har_profile}}` has already been run. The generic harness
adaptation prompt from that init is included below.

Do **not** run `har env init --auto`. Edit harness files directly.

The benchmark runner validates readiness **after** your edits — do not launch or
verify slots yourself.

**HAR purpose:** a sandbox where agents verify that code changes work. Quick verify
is smoke for the pre-fix gate. Functional proof is `verify --full` via
`verificationStages`. The fix agent may add stages and small tests on the fly.

**SWE-bench grading is external** — do not replicate the official evaluator.

## Benchmark constraints (override the generic prompt where they conflict)

| Topic | Benchmark rule |
|-------|----------------|
| `launch.sh` / `agent-slot.sh` | **Do not edit** — runner owns worktrees and slot registry |
| Allowed edits | `harness.env`, `verify.sh` (quick smoke), `stages.json`, `.har/stages/*`, `CLAUDE.agent.md`, `README.md`, `AGENT.md` |
| During setup | Do **not** run `har env launch`, `./.har/launch.sh`, `./.har/teardown.sh`, or `./.har/verify.sh` |
| Quick verify | Smoke only — compile/import/build (smoke-only pre-fix gate) |
| Full verify | Register functional `verificationStages` (CLI/API/module exercise, focused check). Not the whole suite unless that is truly the repo's lightweight check |
| Profile | Stay on `{{har_profile}}` — do not re-init with a different profile |

`launch.sh` / `agent-slot.sh`: **Do not edit** — runner owns worktrees and slot replace/force.

Document in `.har/CLAUDE.agent.md` / `AGENT.md`:
- quick verify = smoke
- done = `verify --full`
- agents **may add stages on the fly** and may add a small focused test/check when needed
- HAR is the verification sandbox for changes

## Generic HAR adaptation prompt (from `har env init`)

---

{{har_adapt_prompt}}

---

{{setup_failure_context}}

When finished, summarize smoke commands for quick verify and any **repo-generic**
`--full` stage (not issue-specific).
