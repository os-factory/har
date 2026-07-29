# Re-run SWE-bench HAR on the benchmark EC2

This is the runbook for the **already-running** Amazon Linux host used for SWE-bench HAR batches. The `sshbench` alias only SSHes in — it does not start or stop the instance.

## Connect

From a laptop that has the PEM key:

```bash
alias sshbench="ssh -i ~/Documents/kerno/Antoine.pem ec2-user@ec2-3-250-195-78.eu-west-1.compute.amazonaws.com"
sshbench
```

| | |
|--|--|
| User | `ec2-user` |
| Host | `ec2-3-250-195-78.eu-west-1.compute.amazonaws.com` |
| Region | `eu-west-1` |
| Repo on box | `~/har` |
| Benchmark dir | `~/har/benchmarks/swebench-har` |

## What a full re-run does

1. Bootstrap host deps (idempotent): Node, Docker, `uv`, build HAR CLI, `uv sync`
2. Clear `.har-cache/` (recommended when launch/verify contracts changed)
3. `run_batch.py --count 10 --seed 42 --arm both` (same sample as baseline `20260708-173731`)
4. Official SWE-bench Docker eval via `evaluate_batch.py`
5. Write `results/ec2-comparison.json` vs that baseline

Expect **multi-hour** wall time (setup budgets + Codex + Docker eval). Always use `tmux`.

## Sync the code you want to measure

On the EC2 box the checkout lives at `~/har`. Prefer one of:

**A — git (when the branch is pushed)**

```bash
sshbench
cd ~/har
git fetch origin
git checkout <branch-or-sha>
git pull --ff-only
```

**B — rsync from your laptop worktree (unpushed local changes)**

```bash
rsync -az --delete \
  --exclude node_modules \
  --exclude .venv \
  --exclude dist \
  --exclude '.har/slots' \
  --exclude '.har/runs' \
  --exclude '.har/state' \
  --exclude 'benchmarks/swebench-har/.venv' \
  --exclude 'benchmarks/swebench-har/.har-cache' \
  --exclude 'benchmarks/swebench-har/.repo-cache' \
  --exclude 'benchmarks/swebench-har/runs' \
  --exclude 'benchmarks/swebench-har/batches' \
  --exclude 'benchmarks/swebench-har/results' \
  --exclude 'benchmarks/swebench-har/logs' \
  --exclude 'benchmarks/swebench-har/.env.local' \
  -e "ssh -i ~/Documents/kerno/Antoine.pem" \
  /path/to/har-checkout/ \
  ec2-user@ec2-3-250-195-78.eu-west-1.compute.amazonaws.com:~/har/
```

Do **not** rsync over `.env.local` (API keys stay on the box).

## One-time / idempotent bootstrap

```bash
sshbench
cd ~/har
bash benchmarks/swebench-har/scripts/ec2_bootstrap.sh
```

This will:

- Install packages / ensure Docker + Node ≥ 20 + `uv`
- `npm ci && npm run build` → `~/har/dist/index.js`
- `uv sync` under `benchmarks/swebench-har`
- Create `benchmarks/swebench-har/.env.local` if missing

### API key

`OPENAI_API_KEY` is required. Bootstrap will reuse it from:

1. The environment (`export OPENAI_API_KEY=...`), or
2. `~/aicore/benchmark/.env` on this host (if present)

Optional in `.env.local`:

```bash
OPENAI_MODEL=gpt-5-mini
OPENAI_SETUP_MODEL=gpt-5.5
HF_TOKEN=...          # higher Hugging Face rate limits
HAR_BIN=/home/ec2-user/har/dist/index.js
```

Never commit `.env.local`.

### Disk

```bash
df -h /
```

Aim for **≥40 GB free** (100 GB+ is safer). SWE-bench Docker images and repo caches grow quickly. Prune if needed:

```bash
docker system df
# careful — removes unused images/containers:
# docker system prune -a
```

## Run the benchmark (headless)

```bash
sshbench
cd ~/har/benchmarks/swebench-har

# optional: kill a leftover session
tmux kill-session -t swebench 2>/dev/null || true

tmux new -s swebench
# inside tmux:
bash scripts/ec2_run.sh
# defaults: COUNT=10 SEED=42 ARM=both, clears .har-cache, then eval
```

Detach: `Ctrl-b` then `d`. Reattach: `tmux attach -t swebench`.

### Useful flags / env

```bash
# Bootstrap then run
bash scripts/ec2_run.sh --bootstrap

# Keep existing .har-cache (faster; only if harness contract unchanged)
bash scripts/ec2_run.sh --keep-cache

# Orchestration only (skip official Docker eval)
bash scripts/ec2_run.sh --skip-eval

# Different sample size (apples-to-apples comparison uses 10 / 42)
COUNT=25 SEED=42 bash scripts/ec2_run.sh

# Dry-run plumbing (no Codex / no real eval work)
bash scripts/ec2_run.sh --dry-run
```

Stdin is redirected from `/dev/null` in the recommended tmux one-liner above if you wrap it:

```bash
tmux new -s swebench "bash -lc 'source ~/.nvm/nvm.sh; cd ~/har/benchmarks/swebench-har && bash scripts/ec2_run.sh </dev/null; exec bash'"
```

That avoids interactive `har env init` prompts on a TTY.

## Monitor

```bash
sshbench
tmux attach -t swebench
# or:
tail -f ~/har/benchmarks/swebench-har/logs/ec2-batch-*.log
```

When finished, `ec2_run.sh` prints `results/ec2-comparison.json` and exits `0`.

## Artifacts

Under `~/har/benchmarks/swebench-har/`:

| Path | Meaning |
|------|---------|
| `batches/<batch_id>/batch.json` | Per-instance orchestration status |
| `runs/<run-id>/run.json` | Raw/HAR arm metrics, gates, cache |
| `runs/<run-id>/predictions/{raw,har}.jsonl` | SWE-bench submission patches |
| `results/ec2-comparison.json` | Summary vs baseline `20260708-173731` |
| `results/batch-<id>/batch-evaluation.md` | Per-instance resolve table |
| `logs/ec2-batch-*.log` / `logs/ec2-eval-*.log` | Full stdout |
| `logs/run_evaluation/` | Official harness Docker reports |

Copy results home:

```bash
scp -i ~/Documents/kerno/Antoine.pem -r \
  ec2-user@ec2-3-250-195-78.eu-west-1.compute.amazonaws.com:~/har/benchmarks/swebench-har/results \
  ./swebench-results-$(date +%Y%m%d)/
```

## Apples-to-apples comparison

Default sample matches the first report ([BENCHMARK-RUN-REPORT.md](./BENCHMARK-RUN-REPORT.md)):

- Dataset: SWE-bench Lite `test`
- `--count 10 --seed 42 --arm both`
- Fix/raw model: `gpt-5-mini`
- HAR setup model: `gpt-5.5`

Baseline orchestration (2026-07-08): raw patches **10/10**, HAR patches **5/10** (gate failures). Official resolve was not measured then.

Latest successful EC2 batch on this host: **`20260718-185954`** — HAR patches **10/10**, official resolve raw **4/10** / HAR **5/10**.

## Eval-only re-run

If orchestration finished but you need to re-score:

```bash
cd ~/har/benchmarks/swebench-har
uv run scripts/evaluate_batch.py --batch-id 20260718-185954
# or
uv run scripts/evaluate_batch.py --latest-batch
```

## Clean re-run checklist

1. Sync the commit under test to `~/har`
2. `bash scripts/ec2_bootstrap.sh` (or `ec2_run.sh --bootstrap`)
3. Confirm `df -h /` and Docker works (`docker info`)
4. Confirm `.env.local` has `OPENAI_API_KEY`
5. Archive or leave old `batches/` / `runs/` (new batch id is timestamped)
6. Clear cache unless intentionally measuring cache reuse: default `ec2_run.sh` clears `.har-cache`
7. Start under `tmux` → `bash scripts/ec2_run.sh`
8. When done, read `results/ec2-comparison.json` and `results/batch-*/batch-evaluation.md`

## Known pitfalls (this host)

| Symptom | Fix |
|---------|-----|
| `Permission denied: .../dist/index.js` | HAR must be invoked via `node` (fixed in `resolve_har_base_cmd`); re-bootstrap / rebuild `dist/` |
| `har env init` hangs in tmux | Non-interactive flags + stdin `/dev/null` (see above); init uses `--no-cursor-rule --no-agents` |
| HF Hub rate-limit warnings | Set `HF_TOKEN` in `.env.local` |
| Disk full during Docker eval | Free space / prune images; prefer ≥100 GB free before large batches |
| Stale bad `.har-cache` | Re-run without `--keep-cache` (default clears cache) |

## Scripts reference

| Script | Role |
|--------|------|
| [`scripts/ec2_bootstrap.sh`](./scripts/ec2_bootstrap.sh) | Host + CLI + Python deps + `.env.local` |
| [`scripts/ec2_run.sh`](./scripts/ec2_run.sh) | Preflight → batch → batch eval → comparison |
| [`scripts/run_batch.py`](./scripts/run_batch.py) | Multi-instance orchestration |
| [`scripts/evaluate_batch.py`](./scripts/evaluate_batch.py) | Official eval over a whole batch |
| [`scripts/test_swebench_har.py`](./scripts/test_swebench_har.py) | Local smoke (no Codex / Docker grading) |

For local (non-EC2) usage, see [README.md](./README.md).
