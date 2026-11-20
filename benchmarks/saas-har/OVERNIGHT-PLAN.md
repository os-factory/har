# Overnight run plan — protocol v2

**Approved and started 2026-09-11.** See "Decisions taken at launch" below.

## What is already done (this evening)

| | |
|---|---|
| Protocol v2 implemented | one minimal arm-identical prompt, no pre-launched slot, behaviour measured (`PROTOCOL.md`) |
| Leak removal | opaque checkouts at `~/agentbench-work/<sha1>/…`, branch `task-base`, harness commit `chore: development environment setup` by `dev` |
| Unattended safety | usage-limit wait/retry, one-runner flock, low-disk stop, work-dir and scorer cleanup |
| Guards | 9 protocol tests (prompt neutrality, task-blindness, patch filtering, behaviour classification) |
| Smoke test | `marked-684`, both arms, **A ✓ / B ✓** — and ARM A launched a slot and ran `verify --full` with **no instruction to do so** |
| Pre-flight | `marked-1262` running now through the exact unattended code path |

## Phases (sequential, one runner, `--resume` so nothing is repeated)

| # | What | Instances | Est. time | Est. cost |
|---|---|---|---|---|
| 1 | Re-run the five v1-graded instances under v2: `marked-1262`, `fastapi-1396/1543/2104` (`marked-684` already v2) | 4 | 50 min | $5 |
| 2 | `IBM/mcp-context-forge`, oldest six by base-commit date (harness cached, gate ≈6 min for its 31k-test suite) | 6 | 2 h | $12 |
| 3 | `markedjs/marked`, the remaining twelve dev-split instances (cheap, gives one repo at n=14) | 12 | 1 h 15 | $12 |
| 4 | **B′ ablation** (`--arm raw_verify`) on everything already run in v2 | ~20 | 45 min | $8 |
| 5 | `chartjs/Chart.js`, fresh task-blind adaptation + oldest three instances (browser-test stratum) | 3 | 2 h | $10 |
| | **Total** | **~25 paired + 20 ablation** | **≈7 h** | **≈$47** |

Order is deliberate: the certain, already-cached work runs first; the one fresh adaptation
(Chart.js, the least predictable step) runs last so it cannot consume the night's budget.

Exact commands, in this order:

```bash
uv run scripts/run_campaign.py --datasets swebench-mm-dev --repos markedjs/marked --limit-per-repo 2 --arm both --resume
uv run scripts/run_campaign.py --datasets newtypebench --repos fastapi/full-stack-fastapi-template --arm both --resume
uv run scripts/run_campaign.py --datasets newtypebench --repos IBM/mcp-context-forge --limit-per-repo 6 --arm both --resume
uv run scripts/run_campaign.py --datasets swebench-mm-dev --repos markedjs/marked --arm both --resume
uv run scripts/run_campaign.py --datasets swebench-mm-dev --repos markedjs/marked --arm raw_verify --resume
uv run scripts/run_campaign.py --datasets newtypebench --repos fastapi/full-stack-fastapi-template IBM/mcp-context-forge --limit-per-repo 6 --arm raw_verify --resume
uv run scripts/run_campaign.py --datasets swebench-mm-dev --repos chartjs/Chart.js --limit-per-repo 3 --arm both --resume
uv run scripts/report.py
```

A single wrapper script (`scripts/overnight.sh`) runs them in sequence, logs to
`logs/overnight-<date>.log`, and stops early on low disk.

## What we expect to learn

1. **Behavioural difference at n≈25**: how often each arm starts the app, runs the project's real
   tests, and verifies at all, when nothing asks it to. The smoke test suggests ARM A adopts
   `har env launch` + `verify --full` and ARM B substitutes its own ad-hoc setup.
2. **Whether that changes resolution rates** on backend-API tasks (mcp-context-forge is the real
   test: 68 instances available, a large FastAPI service with a heavy suite).
3. **B′ separates the mechanism**: if B′ ≈ A, the effect is "tell the model to verify"; if
   B′ ≈ B, the effect needs the harness.
4. **Harness economics at scale**: first adaptation cost per repository versus per-commit drift
   cost, cache-hit rate, gate-pass-unchanged rate.
5. **A harder stratum** (Chart.js: browser tests, image-bearing issues) where a pre-built
   environment should matter more than it did on trivial instances.

## Risks and mitigations

| Risk | Mitigation | Residual |
|---|---|---|
| **Usage cap** on the claude.ai plan (it stopped three v1 sessions at 19:41) | detect, wait 20 min, retry up to 5× per session; invalid sessions are never scored and `--resume` re-runs them | a long cap window costs wall-clock. Fix: put `ANTHROPIC_API_KEY=…` in `.env.local` to bill the API instead — **your call, cost changes** |
| **Disk** (35 GB free now) | work dirs and scorer workspaces deleted after each instance; campaign stops cleanly below 8 GB | Chart.js eval images (~2 GB each) are the biggest consumer. Optional pre-step: `docker builder prune -f` (≈30 GB reclaimable) |
| Chart.js adaptation fails | 100-minute budget, then the soft gate; failure costs the phase, not the night | phase 5 is last on purpose |
| mcp-context-forge gate is slow | `gate_timeout_minutes: 45` | if a gate times out the instance is recorded as a gate failure, not a silent pass |
| An agent commits and tears down its slot | patch discovery falls back to the session branch; branches are now kept | recovered a dangling commit once tonight; the guard is in place |

## What I will do when it finishes

Update `results/REPORT.md`, `PILOT-REPORT.md` (v2 sections, outcomes + behaviour + economics),
`NOTES.md` (chronology, incidents), and report: per-arm resolution rates by dataset and repo,
behaviour rates, harness economics, the failure taxonomy for every unresolved pair, and any new
HAR product findings from the adaptation transcripts.

## Decisions taken at launch (2026-09-11)

- **Approved** by the operator; run started with the code frozen (no edits to `scripts/` while
  phases execute, so every phase runs identical code).
- **Billing**: unchanged — the existing Claude Code session auth, with usage-limit wait/retry.
  No `ANTHROPIC_API_KEY` was added.
- **Docker prune**: not run. The build cache is left alone; the campaign relies on per-instance
  cleanup and the 8 GB low-disk stop, and the phase that consumes the most disk (Chart.js) is last.
- **Repeats**: not included. One attempt per arm per instance; repeats can be added later as a
  separate campaign because each run is recorded independently. See the limitations section of
  `PILOT-REPORT.md`.
