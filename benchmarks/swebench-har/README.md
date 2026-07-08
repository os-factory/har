# SWE-bench HAR Benchmark

Paired one-instance benchmark comparing **raw Codex (GPT-5 Mini)** against **HAR-assisted Codex** on a SWE-bench Lite task.

- **Raw arm:** Codex solves the issue directly in a checkout at `base_commit` (default: `gpt-5-mini`).
- **HAR arm:** scaffold-only `har env init` (no `--auto`), **GPT-5.5** adapts `.har/` using the init `ADAPT-PROMPT.md` plus benchmark constraints, runner enforces launch + smoke gates, **GPT-5 Mini** fixes inside the slot.
- **Scoring:** official SWE-bench Docker harness via `swebench.harness.run_evaluation`.

## Prerequisites

- Node.js >= 20 and a built HAR CLI (`npm run build` in the repo root, or `har` on `PATH`)
- Docker (for official SWE-bench evaluation)
- [uv](https://docs.astral.sh/uv/)
- `OPENAI_API_KEY` for Codex SDK

## Setup

```bash
cd benchmarks/swebench-har
cp env.example .env.local
# edit OPENAI_API_KEY=...
uv sync
```

## Run multiple instances

```bash
uv run scripts/run_batch.py --count 10 --seed 42 --arm both
```

See [BENCHMARK-RUN-REPORT.md](./BENCHMARK-RUN-REPORT.md) for findings from the first 10-instance batch and recommended follow-up issues.

## Run one paired attempt

```bash
uv run scripts/run_one.py --seed 42
# defaults: fix/raw = gpt-5-mini, HAR setup = gpt-5.5
```

Override models:

```bash
uv run scripts/run_one.py --seed 42 --model gpt-5-mini --setup-model gpt-5.5
```

Pin a specific instance:

```bash
uv run scripts/run_one.py --instance-id astropy__astropy-12907
```

Dry-run orchestration (no Codex, no clones):

```bash
uv run scripts/run_one.py --seed 42 --dry-run
```

Run a single arm:

```bash
uv run scripts/run_one.py --seed 42 --arm raw
uv run scripts/run_one.py --seed 42 --arm har
```

## Evaluate with official SWE-bench

```bash
uv run scripts/evaluate_predictions.py --latest
uv run scripts/evaluate_predictions.py --run-id 20260708-120000-astropy-astropy-12907
```

Dry-run evaluation wrapper:

```bash
uv run scripts/evaluate_predictions.py --latest --dry-run
```

## Outputs

```text
benchmarks/swebench-har/
  .har-cache/<repo>/       # reused adapted .har/ per repository
  runs/<run-id>/
    instance.json          # sampled task (no gold patch in agent payload)
    run.json               # paired arm metrics
    raw/repo/              # raw checkout
    har/repo/              # harness root checkout
    har/artifacts/         # .har/runs, slots, logs
    predictions/raw.jsonl  # SWE-bench submission format
    predictions/har.jsonl
  results/<run-id>/
    evaluation-raw.json
    evaluation-har.json
    evaluation-summary.json
```

## HAR enforcement

The HAR arm records:

- `har_cache_hit` / `har_cache_saved` — per-repo `.har/` reuse
- `har_gate_initial` / `har_gate_attempt_*` — pre-fix gate before Codex fix (launch + smoke)
- `har_gate_launch` / `har_gate_smoke` — split launch readiness vs quick smoke verify
- `har_ready_for_fix` — slot launched and smoke verify passed (not full test suite)
- `har_launch.ok`
- `har_verify_attempted` / `har_verify_passed` — post-fix verify (optionally `--full` via `har_verify_full` config)
- `.har/runs/**` artifacts
- `har_valid` and `har_invalid_reasons`

`model_patch` excludes `.har/**`, `.cursor/**`, and other harness scaffolding so SWE-bench grading only sees product-code changes.

## Pre-fix gate vs post-fix verify

| Phase | What runs | Purpose |
|-------|-----------|---------|
| **Pre-fix gate** | `har env launch 1` + quick `har env verify 1` | Prove the agent can work in the slot (compile/import/build smoke) |
| **Post-fix** | `har env verify 1` (or `--full` when `har_verify_full: true`) | Optional harness check after the patch; SWE-bench grading is separate |

Quick verify must be **language-agnostic** — compile/import/build smoke, not full pytest/Django runtests/Sphinx extension graphs.

## Per-repo `.har/` cache

Adapted harness files are cached under `.har-cache/<repo>/` and reused across instances of the same repository (different `base_commit` values). Before the fix stage the runner always:

1. tears down any occupied slot
2. runs `har env launch 1 --replace --force` (with `HAR_CONFIRM_REPLACE=1`)
3. runs quick `har env verify 1` (smoke only — no `--full`)

If the gate fails, the setup model re-adapts `.har/` (up to `setup_max_attempts`, default 2) and the cache is refreshed on success.

## Profile selection

`har env init` profile is inferred per repository:

- `cli` — Python/library/test-suite repos (typical for SWE-bench Lite)
- `default` — web-app repos with frontend dev-server signals
- `ios` — iOS / Swift mobile apps (xcodebuild, simulator)

## HAR setup prompt

The setup agent receives `prompts/har-setup.md`, which embeds the same text as
`.har/ADAPT-PROMPT.md` from `har env init`, plus SWE-bench-specific constraints
(no `launch.sh` edits, smoke-only pre-fix gate, no slot launch during setup).

## Smoke tests

```bash
uv run scripts/test_swebench_har.py
```

## Caveats

- One random instance is a feasibility smoke test, not a statistically meaningful benchmark.
- HAR setup uses a stronger model than the fix arm by design; fix/raw arms stay on the same model for fair comparison.
- Official SWE-bench evaluation requires substantial Docker disk space and time on first run.
