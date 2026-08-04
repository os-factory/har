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

**SWE-bench grading is external.** Harness quick verify is smoke-only (compile /
import / build); it does not need to pass the repo's full test suite.

## Benchmark constraints (override the generic prompt where they conflict)

| Topic | Benchmark rule |
|-------|----------------|
| `launch.sh` / `agent-slot.sh` | **Do not edit** — runner owns worktrees and slot registry |
| Allowed edits | `harness.env`, `verify.sh` (especially quick-mode smoke steps), `CLAUDE.agent.md`, `README.md`, repo-root `AGENTS.md` |
| During setup | Do **not** run `har env launch`, `./.har/launch.sh`, `./.har/teardown.sh`, or `./.har/verify.sh` |
| Quick verify | Language-agnostic smoke only — not full pytest/Django runtests/Sphinx graphs |
| Full verify | Optional stricter checks (`--full`); not required for the pre-fix gate |
| Profile | Stay on `{{har_profile}}` — do not re-init with a different profile |

Pre-fix gate the runner enforces: `har env launch 1` + quick `har env verify 1`.

Quick-mode examples (pick what fits this stack):

- Python: `python -m compileall`, `pip install -e .`, import smoke
- Node: `npm run build`, `npm run typecheck`
- Java: `mvn -q compile`, `./gradlew compileJava`
- Go: `go build ./...`
- Rust: `cargo check`

## Generic HAR adaptation prompt (from `har env init`)

The following is the same prompt saved to `.har/ADAPT-PROMPT.md` — follow it except
where the benchmark constraints above take precedence.

---

{{har_adapt_prompt}}

---

{{setup_failure_context}}

When finished, summarize what you changed and which **smoke** commands quick verify will run.
