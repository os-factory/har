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
# Diversified sample (caps from config.yaml by default):
uv run scripts/run_batch.py --count 50 --seed 42 --arm both \
  --max-per-repo 5 --max-repos-per-language 10
```

Paper iteration log: [`BENCHMARK-ITERATIONS.md`](./BENCHMARK-ITERATIONS.md). EC2 campaign: [`EC2.md`](./EC2.md).

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

- `har_cache_hit` / `har_cache_saved` / `har_cache_invalidated` — per-repo `.har/` reuse and invalidation
- `har_bootstrap_attempts` / `har_task_readiness` — two-phase setup (repo bootstrap vs task readiness)
- `har_setup_budget_minutes` / `har_setup_budget_used_seconds` / `har_setup_rounds` — budget-based retries
- `har_gate_initial` / `har_gate_round_*` — pre-fix gate before Codex fix (launch + smoke)
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

## Two-phase HAR setup

Setup is split into two agent phases with different scope, models, and cache behavior:

| Phase | When | Model | Cached |
|-------|------|-------|--------|
| **Repo bootstrap** | Cache miss, or gate failure after cache hit | `setup_model` (default GPT-5.5) | Yes — saved to `.har-cache/<repo>/` |
| **Task readiness** | Every instance | `model` (default GPT-5-mini) | No — per-run overlay under `runs/<id>/har/task-overlay/` |

```text
Cache hit?
  → task readiness (mini) → pre-fix gate → fix

Cache miss / gate fail?
  → repo bootstrap (5.5) → task readiness (mini) → gate
  → retry until setup_budget_minutes or setup_max_rounds
  → invalidate cache on gate failure after cache hit
```

Task readiness receives the `problem_statement` and may add one lightweight task-scoped smoke check as an ephemeral overlay — it does not rewrite repo-generic cached harness defaults.

## Per-repo `.har/` cache

Adapted harness files are cached under `.har-cache/<repo>/` and reused across instances of the same repository (different `base_commit` values). Before the fix stage the runner always:

1. tears down any occupied slot
2. runs `har env launch 1 --replace --force` (with `HAR_CONFIRM_REPLACE=1`)
3. runs quick `har env verify 1` (smoke only — no `--full`)

If the gate fails after a cache hit, the cache is **invalidated** and repo bootstrap runs again. Retries continue until `setup_budget_minutes` (default 120) is exhausted or `setup_max_rounds` (default 6) is reached. Structured gate JSON is passed to setup retries.

## Profile selection

`har env init` profile is inferred per repository:

- `cli` — Python/library/test-suite repos (typical for SWE-bench Lite)
- `default` — web-app repos with frontend dev-server signals
- `ios` — iOS / Swift mobile apps (xcodebuild, simulator)

## HAR setup prompts

- **Repo bootstrap** — `prompts/har-setup.md` (GPT-5.5): embeds `.har/ADAPT-PROMPT.md`, repo-generic harness adaptation, no `launch.sh` edits
- **Task readiness** — `prompts/har-task-readiness.md` (GPT-5-mini): per-instance check with `problem_statement`, optional ephemeral task overlay

## Smoke tests

```bash
uv run scripts/test_swebench_har.py
```

## Running on EC2 (`sshbench`)

Full re-run instructions for the shared benchmark host (connect, sync code, bootstrap, tmux, artifacts, pitfalls): see **[EC2.md](./EC2.md)**.

Quick start:

```bash
alias sshbench="ssh -i ~/Documents/kerno/Antoine.pem ec2-user@ec2-3-250-195-78.eu-west-1.compute.amazonaws.com"
sshbench
cd ~/har && bash benchmarks/swebench-har/scripts/ec2_bootstrap.sh
tmux new -s swebench
cd ~/har/benchmarks/swebench-har && bash scripts/ec2_run.sh
```

## Caveats

- One random instance is a feasibility smoke test, not a statistically meaningful benchmark.
- HAR setup uses a stronger model than the fix arm by design; fix/raw arms stay on the same model for fair comparison.
- Official SWE-bench evaluation requires substantial Docker disk space and time on first run.
