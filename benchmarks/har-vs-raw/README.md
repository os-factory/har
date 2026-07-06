# HAR vs Raw Claude Code Benchmark

Paired benchmark framework comparing **raw Claude Code** against **Claude Code in a HAR-enabled repository** on frontend GitHub issue replays.

Design principles:

- **One neutral issue-fix prompt** for both arms (`prompts/fix-issue.md`)
- **HAR specialization only during harness setup** (`har env init`, `har env add-stage playwright`, setup prompt)
- **Langfuse** for traces/scores; **local run JSON** for HAR artifacts and verification evidence

## Layout

```text
benchmarks/har-vs-raw/
  config.yaml           # dataset name, score configs, pilot settings
  repos.yaml            # 10 target repositories
  issues.yaml           # curated replay items (generated)
  prompts/
    fix-issue.md        # identical task prompt for raw + har
    setup-har.md        # one-time harness adaptation prompt
  scripts/
    setup-langfuse.sh
    select_issues.py
    create_dataset.py
    setup_harness.py
    run_task.py
    run_benchmark.py
    evaluate_run.py
    report.py
  runs/                 # per-attempt workspaces (gitignored)
  results/              # reports and manifests
  repos/                # cloned repositories + adapted harnesses
```

## Quick start

### 1. Langfuse

```bash
cd benchmarks/har-vs-raw
cp .env.local.example .env.local
./scripts/setup-langfuse.sh
# create project + API keys in UI, fill .env.local
```

See [docs/langfuse-setup.md](docs/langfuse-setup.md).

### 2. Curate issues

```bash
python3 scripts/select_issues.py
```

Optional: `GITHUB_TOKEN` in `.env.local` for higher GitHub API limits.

### 3. Create Langfuse dataset

```bash
python3 scripts/create_dataset.py
# or dry-run:
python3 scripts/create_dataset.py --dry-run
```

### 4. Set up HAR harnesses (once per repo)

Classic setup only — do **not** change the issue-fix prompt:

```bash
python3 scripts/setup_harness.py --repo lightdash/lightdash
# full adaptation with Claude Code:
python3 scripts/setup_harness.py --repo lightdash/lightdash
```

`--skip-agent` scaffolds `.har/` via CLI only; full adaptation runs Claude Code with `prompts/setup-har.md`.

### 5. Run benchmark

Pilot (1 repo, 2 issues):

```bash
python3 scripts/run_benchmark.py --mode pilot
```

Full benchmark (all issues, paired arms, randomized order):

```bash
python3 scripts/run_benchmark.py --mode full
```

Dry-run orchestration (no Claude Code):

```bash
python3 scripts/run_benchmark.py --mode pilot --dry-run
```

Single attempt:

```bash
python3 scripts/run_task.py --arm raw --repo lightdash/lightdash --issue-number 22515
python3 scripts/run_task.py --arm har --repo lightdash/lightdash --issue-number 22515
python3 scripts/evaluate_run.py --run-json runs/<run>/run.json --dry-run
python3 scripts/report.py
```

## Evaluation

External verification (not in the agent prompt):

- **HAR arm**: `har env verify 1 --full` after the attempt
- **Raw arm**: best-effort repo-native test command

Scores posted to Langfuse when `--trace-id` is provided:

- `success`, `verified`, `e2e_added_or_updated`
- `wall_clock_seconds`, token/cost metrics when available
- `verify_attempts`, `failed_verify_attempts`
- `quality` (`good` / `partial` / `bad`)

Reports:

- `results/report.json`
- `results/report.csv`
- `results/report.md`

## Bias controls

- Same prompt, model, budget, telemetry, and secrets for both arms
- Randomized arm order per issue
- Fresh clone/worktree per attempt at the same `base_commit`
- Raw arm: no `.har/`, no HAR MCP (`--strict-mcp-config`)
- HAR arm: harness overlay + HAR MCP only as side effect of setup
- Reference PR/patch hidden from agent; evaluator-only ground truth

## Target repositories

| Repo | Primary app |
| --- | --- |
| lightdash/lightdash | packages/frontend |
| novuhq/novu | apps/web |
| jitsi/jitsi-meet | . |
| n8n-io/n8n | packages/frontend/editor-ui |
| directus/directus | app |
| zulip/zulip | web |
| strapi/strapi | packages/core/admin |
| getsentry/sentry | static/app |
| appsmithorg/appsmith | app/client |
| mattermost/mattermost | webapp |
