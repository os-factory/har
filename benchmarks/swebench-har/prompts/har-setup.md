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
import / build) for the pre-fix gate. Separately, you **must** register at least
one **functional** verification stage for `har env verify 1 --full` so the fix
agent can prove its change works through HAR (not via the official evaluator).

## Benchmark constraints (override the generic prompt where they conflict)

| Topic | Benchmark rule |
|-------|----------------|
| `launch.sh` / `agent-slot.sh` | **Do not edit** — runner owns worktrees and slot registry |
| Allowed edits | `harness.env`, `verify.sh` (especially quick-mode smoke steps), `CLAUDE.agent.md`, `README.md` |
| During setup | Do **not** run `har env launch`, `./.har/launch.sh`, `./.har/teardown.sh`, or `./.har/verify.sh` |
| Quick verify | Language-agnostic smoke only — not full pytest/Django runtests/Sphinx graphs |
| Full verify | Register functional `verificationStages` (CLI/API/module exercise, focused check). Not the whole suite unless that is truly the repo's lightweight check |
| Profile | Stay on `{{har_profile}}` — do not re-init with a different profile |

Pre-fix gate the runner enforces: `har env launch 1` + quick `har env verify 1`.

After the fix, the runner also runs `har env verify 1 --full` — your functional
stages must be registered so that path is meaningful.

Quick-mode examples (pick what fits this stack):

- Python: `python -m compileall`, `pip install -e .`, import smoke
- Node: `npm run build`, `npm run typecheck`
- Java: `mvn -q compile`, `./gradlew compileJava`
- Go: `go build ./...`
- Rust: `cargo check`

Functional stage examples (for `--full` / definition of done — keep them small):

```bash
har env add-stage module-smoke --custom --kind test \
  --command '${PYTHON_BIN:-python3} -c "import <pkg>; …exercise fixed API…"' \
  --verification
```

Or a short `.har/stages/<id>.sh` via `har env add-stage <id> --custom --script --verification`.

Update `.har/CLAUDE.agent.md` / `AGENT.md` so definition of done says: quick verify
is smoke; finishing requires `verify --full`; if no stage covers the change, add one.

## Generic HAR adaptation prompt (from `har env init`)

The following is the same prompt saved to `.har/ADAPT-PROMPT.md` — follow it except
where the benchmark constraints above take precedence.

---

{{har_adapt_prompt}}

---

{{setup_failure_context}}

When finished, summarize:
1. which **smoke** commands quick verify will run
2. which **functional** verification stage(s) you registered for `--full`
