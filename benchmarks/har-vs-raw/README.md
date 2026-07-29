# HAR vs Raw Claude Code Benchmark

Paired benchmark framework comparing **raw Claude Code** against **Claude Code in a HAR-enabled repository** on frontend GitHub issue replays.

Design principles:

- **One neutral issue-fix prompt** for both arms (`prompts/fix-issue.md`)
- **HAR specialization only during harness setup** (`har env init`, `har env add-plugin playwright`, setup prompt)
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

## V3 campaign (smaller repos, fork-first, manual harness gate)

Replaces the pilot monorepos with four smaller targets (keep was listed twice — using **4 unique repos**):

| Upstream | os-factory fork | Stack |
| --- | --- | --- |
| [formbricks/formbricks](https://github.com/formbricks/formbricks) | `os-factory/formbricks` | Next.js / pnpm |
| [directus/directus](https://github.com/directus/directus) | `os-factory/directus` | Vue + Node / pnpm |
| [keephq/keep](https://github.com/keephq/keep) | `os-factory/keep` | Python + Next.js |
| [evershopcommerce/evershop](https://github.com/evershopcommerce/evershop) | `os-factory/evershop` | TS e-commerce / npm |

Config: `config.v3.yaml`, `repos.v3.yaml`.

### Prerequisites

```bash
cd benchmarks/har-vs-raw
cp .env.local.example .env.local   # add GITHUB_TOKEN with org fork permissions
```

### Live dashboard

```bash
python3 scripts/dashboard.py --port 8765
# open http://127.0.0.1:8765
```

Shows per-repo phase status, log tailing, and **Approve harness** after manual testing.

### Phased workflow (each step runnable alone)

```bash
# 1. Fork upstream repos into os-factory + clone locally
python3 scripts/run_phase.py fork

# 2. Scaffold HAR (har env init, no agent)
python3 scripts/run_phase.py harness-init --repo formbricks

# 3. Claude Code + HAR MCP adapts harness
python3 scripts/run_phase.py harness-adapt --repo formbricks

# 4. Gate: har env verify 1 --full must pass
python3 scripts/run_phase.py harness-verify --repo formbricks

# 5. Push .har to benchmark/har-setup branch on the fork
python3 scripts/run_phase.py harness-push --repo formbricks

# 6. MANUAL: test the branch, then approve:
python3 scripts/run_phase.py approve --repo formbricks --notes "launch + verify OK"

# 7. Curate issues from upstream (see "Issue selection" below)
python3 scripts/run_phase.py select-issues --repo formbricks

# Or pin specific issues you chose manually (open features, styling tasks):
python3 scripts/pin_issues.py --repo formbricks --issues 3710,5418,7933

# 8. Issue-fix sessions (blocked until harness approved)
python3 scripts/run_phase.py run-raw
python3 scripts/run_phase.py run-har

# 9. Report
python3 scripts/run_phase.py report

python3 scripts/run_phase.py status
```

Harness branch: `benchmark/har-setup`. Results: `results/v3/`. State: `state/v3/campaign.json`.

### Issue selection

Two paths:

**Automatic** (`scripts/select_issues.py` / `run_phase.py select-issues`) searches upstream for **closed bugs** with a **merged fix PR** that added regression tests. Each issue gets a concrete test oracle (e.g. `pnpm test -- path/to/spec.ts`) plus `har env verify --full` on the HAR arm. This is the default for comparable raw-vs-HAR scoring (`oracle_pass`, `patch_overlap` vs the reference PR).

**Manual pin** (`scripts/pin_issues.py`) for issues you pick yourself — typically **open feature requests** without a reference fix:

```bash
python3 scripts/pin_issues.py --repo formbricks --issues 3710,5418,7933
```

Writes `issues.v3.yaml` using the harness branch `base_commit`. Verification is `har env verify --full` (no PR patch-overlap oracle). Good for styling/UI feature work; weaker for strict regression replay.

Examples you mentioned (all open features on upstream):

| Issue | Title |
| --- | --- |
| [#3710](https://github.com/formbricks/formbricks/issues/3710) | Allow custom fonts |
| [#5418](https://github.com/formbricks/formbricks/issues/5418) | Custom CSS per survey |
| [#7933](https://github.com/formbricks/formbricks/issues/7933) | Configurable scrollbar width in styling |

After pinning or auto-selecting, mark the phase complete:

```bash
python3 scripts/run_phase.py select-issues --repo formbricks   # auto only
# manual pin updates issues.v3.yaml directly; then set phase in dashboard or re-run status
```

## V3 campaign (smaller repos, fork-first, manual harness gate)

Replaces the pilot monorepos with four smaller targets (you listed keep twice — using **4 unique repos**):

| Upstream | os-factory fork | Stack |
| --- | --- | --- |
| [formbricks/formbricks](https://github.com/formbricks/formbricks) | `os-factory/formbricks` | Next.js / pnpm |
| [directus/directus](https://github.com/directus/directus) | `os-factory/directus` | Vue + Node / pnpm |
| [keephq/keep](https://github.com/keephq/keep) | `os-factory/keep` | Python + Next.js |
| [evershopcommerce/evershop](https://github.com/evershopcommerce/evershop) | `os-factory/evershop` | TS e-commerce / npm |

Config: `config.v3.yaml`, `repos.v3.yaml`.

### Prerequisites

```bash
cd benchmarks/har-vs-raw
cp .env.local.example .env.local   # add GITHUB_TOKEN with org fork permissions
```

### Live dashboard

```bash
python3 scripts/dashboard.py --port 8765
# open http://127.0.0.1:8765
```

Shows per-repo phase status, log tailing, and **Approve harness** after manual testing.

### Phased workflow (each step runnable alone)

```bash
# 1. Fork upstream repos into os-factory + clone locally
python3 scripts/run_phase.py fork

# 2. Scaffold HAR (har env init, no agent)
python3 scripts/run_phase.py harness-init --repo formbricks

# 3. Claude Code + HAR MCP adapts harness (~18 min/repo)
python3 scripts/run_phase.py harness-adapt --repo formbricks

# 4. Gate: har env verify 1 --full must pass
python3 scripts/run_phase.py harness-verify --repo formbricks

# 5. Push .har to benchmark/har-setup branch on the fork (for your manual test)
python3 scripts/run_phase.py harness-push --repo formbricks

# 6. MANUAL: clone os-factory fork, checkout benchmark/har-setup, run har env launch 1
#    Then approve in dashboard or CLI:
python3 scripts/run_phase.py approve --repo formbricks --notes "launch + verify OK"

# 7. Curate issues from upstream (stored with fork slug for runs)
python3 scripts/run_phase.py select-issues

# 8. Issue-fix sessions (blocked until harness approved)
python3 scripts/run_phase.py run-raw
python3 scripts/run_phase.py run-har

# 9. Report
python3 scripts/run_phase.py report

# Check status anytime
python3 scripts/run_phase.py status
```

Harness branch name: `benchmark/har-setup` (configurable in `config.v3.yaml`).

Issue-fix runs clone from **os-factory forks** at `base_commit`, overlay the adapted `.har/` from `repos/<id>/`.

Results: `results/v3/`, state: `state/v3/campaign.json`.

### Adding a new repo later

1. Add entry to `repos.v3.yaml` (upstream + fork org fields).
2. Add upstream slug to `config.v3.yaml` `pilot_repos`.
3. `python3 scripts/run_phase.py fork --repo <id>` and continue the phase chain.

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
