# SWE-bench HAR Benchmark

Paired one-instance benchmark comparing **raw Codex (GPT-5 Mini)** against **HAR-assisted Codex** on a SWE-bench Lite task.

- **Raw arm:** Codex solves the issue directly in a checkout at `base_commit`.
- **HAR arm:** scaffold-only `har env init` (no `--auto`), Codex adapts `.har/`, HAR launches a worktree slot, Codex solves inside the slot, runner enforces `har env verify`.
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

## Run one paired attempt

```bash
uv run scripts/run_one.py --seed 42 --model gpt-5-mini
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

- `har_launch.ok`
- `har_verify_attempted` / `har_verify_passed` (runner-enforced)
- `.har/runs/**` artifacts
- `har_valid` and `har_invalid_reasons`

`model_patch` excludes `.har/**`, `.cursor/**`, and other harness scaffolding so SWE-bench grading only sees product-code changes.

## Profile selection

`har env init` profile is inferred per repository:

- `cli` — Python/library/test-suite repos (typical for SWE-bench Lite)
- `default` — web-app repos with frontend dev-server signals

The benchmark never uses `har env init --auto`.

## Smoke tests

```bash
uv run scripts/test_swebench_har.py
```

## Caveats

- One random instance is a feasibility smoke test, not a statistically meaningful benchmark.
- HAR setup quality depends on the same Codex model adapting `.har/` for each repo.
- Official SWE-bench evaluation requires substantial Docker disk space and time on first run.
