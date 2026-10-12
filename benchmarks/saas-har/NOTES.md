# Lab notebook — SaaS/HAR paired benchmark

Chronological record of what was done, observed, and decided. Times are local (Europe/Paris) unless marked UTC.
Machine: Arch Linux 7.2.3, 14 cores, 62 GB RAM, root disk 937 GB at 95 % (49 GB free at start).
Operator: Claude Code (Fable 5.1) driven by Antoine; every agent session in the benchmark is logged as stream-json under `runs/<run-id>/**/sessions/`.

## 2026-09-10

### Environment established
- `har` global was 1.9.0; upgraded to **@osfactory/har 1.14.1** (npm latest) — `npm install -g @osfactory/har@latest`.
- Claude Code CLI **2.1.267**. Headless smoke: `claude -p --model claude-opus-4-8 --output-format json` and `--model claude-sonnet-5` both answer; cost/usage reported in the JSON result (`modelUsage.canonicalModel` = `claude-opus-4-8`, `claude-sonnet-5`).
- Docker 29.7.2 (overlayfs), Compose v5.0.2. PM2 not installed globally — HAR resolves it via its package runner (`src/runtime/node-pm.ts`), so no action needed.
- Disk pressure: `docker system df` shows 106 GB build cache (94 GB reclaimable), 61 GB images (23 GB reclaimable). Not pruned (operator decision).
- har-project checkout at `f6f9fbd` (release 1.14.0 commit).

### Datasets
- **PrototypeBench**: the HF id `banyaaiofficial/prototypebench-v1` now **redirects to `newtype-2038/newtypebench-v1`** (project renamed *NewtypeBench*, dataset card license **BSL 1.1**, GitHub repo `prototypebench/prototypebench` still says MIT). 123 rows, schema 0.1, all `held_out`: IBM/mcp-context-forge 68 (backend_only), usebruno/bruno 52 (frontend_only), fastapi/full-stack-fastapi-template 3 (backend_only). Rows carry `fail_to_pass`/`pass_to_pass` dicts (backend/frontend), `test_patch`, `environment`. Snapshot saved to `.vendor/newtypebench-instances.jsonl`.
- **SWE-bench Multimodal** (HF `SWE-bench/SWE-bench_Multimodal`, snapshot sha 4e6662d, 2026-08-18): dev 100 / test 480. Test-split repo counts differ slightly from the numbers in the task brief (openlayers 77, bpmn-js 53, alibaba-fusion/next 36, no quarto-cli row). Rows now carry `image` (prebuilt `swebench/sweb.eval.x86_64.<repo>-<n>:latest`), `eval_script`, `log_parser`.
- **swebench 4.1.0 refuses local evaluation of the Multimodal *test* split** (`run_evaluation.py:496` → use sb-cli). Local grading is therefore dev-split only; a test-split number for the paper needs sb-cli submission.
- Prebuilt dev images are public (`docker manifest inspect swebench/sweb.eval.x86_64.markedjs_1776_marked-1262:latest` OK).
- PrototypeBench harness vendored at `.vendor/prototypebench` (`uv sync` OK). Its `pbench score` requires a prior `extract` run; we call `harness.score.score_patch` directly with the dataset's F2P/P2P lists (`scripts/pbench_score_adapter.py`). Backend images built locally from `harness/docker/Dockerfile.backend`: `prototypebench/backend:latest` (py3.10, fastapi template) and `prototypebench/backend-py312:latest` (mcp-context-forge). Frontend (bruno, Playwright+Electron+Xvfb image) not built in the pilot.
- Reference PrototypeBench smoke (README): Opus 4.7, n=20, 600 s timeout, prompt forbids running tests — **not comparable** to an Opus 4.8 / 45-min / verify-encouraged arm. Anthropic's 38.4 % Opus 4.8 on SWE-bench MM is test split + internal harness — also not a substitute for ARM B. Decision: run ARM B ourselves; quote published numbers only as anchors.

### Ordering
Per repo, instances are ordered by the **commit date of `base_commit`** (from bare clones in `.repo-cache/`), oldest first. PR `created_at` can disagree (e.g. `markedjs__marked-684`: PR 2015, base commit 2018-12) — commit date is what the harness drift semantics need.

### Design decisions (fairness)
- Same solve model both arms (`claude-opus-4-8`), same prompt body (`prompts/task.md`), same 45-min timeout, same `--dangerously-skip-permissions`, same downloaded image assets (`--add-dir`). Only `{{env_note}}` differs: HAR arm gets "slot 1 is launched, here is the work dir, use `har env verify`"; raw arm gets "plain checkout, set up what you need". Raw arm additionally has `Bash(har:*)` disallowed (no `.har/` exists there anyway).
- Adaptation (Sonnet 5) is **task-blind**: `prompts/har-adapt.md` / `har-drift.md` never receive the problem statement or instance id (unit-tested). The adaptation agent may launch/verify slot 1 itself; the runner re-validates with its own gate (doctor → launch → verify → verify --full) and only then commits the harness and caches it per repo.
- Cache reuse: next instance of the same repo applies the cached harness, runs `har env maintain` (drift report) + the gate; only on failure does a drift-fix session run.
- Graded patch = working tree vs the harness commit (ARM A) / base commit (ARM B), minus harness-owned paths and minus files the hidden test patch touches (mirrors the PrototypeBench reference runner; avoids apply conflicts in both scorers).
- Hidden fields (gold patch, tests) are never written under `runs/`; transcripts are scanned for accesses to benchmark-internal paths (`suspicious_access`).

### Scorer validation (gold patches)
- 18:19 — `fastapi__full-stack-fastapi-template-1396` gold patch through the vendored PrototypeBench scorer (Docker, Postgres side-car, `uv sync` in `prototypebench/backend:latest`): **score 1, F2P 1/1, P2P 26/26, ~40 s**. Run `runs/20260910-161937-…-1396/score/gold/`.
- 18:19 — `markedjs__marked-1262` gold through swebench failed on arguments: the benchmark venv resolved **swebench 5.0.2** (not 4.1.0 as in `benchmarks/swebench-har`), which dropped `--namespace`/`--cache_level`. Fixed `scripts/lib/scoring.py`; re-running.
- swebench 5.0.2 changes the Multimodal story: `run_evaluation.py:716` now only *informs* that sb-cli exists and **runs the test split locally** (4.1.0 refused). Test-split grading is therefore possible on this machine, disk permitting.

### Pilot campaign 1 — fastapi/full-stack-fastapi-template (3 instances, both arms)
- 18:19 local (16:19:41 UTC) start (`logs/campaign-fastapi.log`, run `20260910-161941-…-1396`). `har env init --profile default` OK in 1 s; Sonnet 5 adaptation round 1 started (task-blind prompt = `.har/ADAPT-PROMPT.md` + benchmark rules).
- 18:29 — `markedjs__marked-1262` gold through swebench 5.0.2: **resolved**, F2P 4/4, 49 s, prebuilt image pulled from Docker Hub. Run `runs/20260910-…-markedjs-marked-1262/score/gold/`. Both scorers validated; `scripts/rescore.py` added to re-grade saved patches if a scorer changes.
- 18:35 — Observation, adaptation round 1 (Sonnet 5): after reading the scaffold it ran `which har; har --version; npm ls -g | grep har; find / -iname …` and then read **HAR's compiled `dist/index.js`** (`sed -n '37990,38230p'`) to learn how launch/PM2/infra behave. The packaged docs (`.har/README.md`, `STAGES.md`, `ADAPT-PROMPT.md`) were not enough on their own — candidate product finding (documentation gap in the scaffold).
- 18:49 — Adaptation round 1 done: 29.3 min, 127 turns, **$6.43** (Sonnet 5). 95 shell commands, 20 `har` invocations (7 verify, 5 doctor, 2 launch, 2 teardown, add-plugin playwright, agent, maintain), 21 commands reading HAR's `dist/index.js`. Result: default profile, `HARNESS_INFRA_SERVICES="db mailpit"`, bun + uv install, Alembic migrate + `initial_data.py` seed, health `/api/v1/utils/health-check/`, readiness = superuser login returns a token, stages quick={typecheck (tsc), backend-import, api-health} full={unit-tests (pytest via stages/backend-tests.sh), backend-lint, frontend-lint, readiness, browser-e2e (playwright plugin)}. Runner gate started.
- 18:52 — **Gate round 1: doctor ✅ launch ✅ verify(quick) ✅ verify --full ❌.** Failing full-tier stages: `unit-tests` (53/55 pass; `tests/scripts/test_backend_pre_start.py` + `test_test_pre_start.py` fail — MagicMock `called_once_with` misspelling that Python ≥3.12 rejects; the slot ran **Python 3.13.13** while the project targets 3.10 → toolchain-version drift the harness must pin), `backend-lint` (mypy `unused "type: ignore"` in `app/api/routes/users.py:223`, same Python-version cause), `browser-e2e` (Playwright 41 tests, reset-password specs time out in `utils/mailcatcher.ts` — the harness started **Mailpit** but the suite expects the project's MailCatcher API). Launch, health, readiness (superuser login) all green. Gate output handed to round 2 (task-blind).
- Runner fix: the campaign process exported `VIRTUAL_ENV=…/saas-har/.venv` into nested `uv` calls (warning in stage output). `load_benchmark_env` now strips `VIRTUAL_ENV`/`UV_PROJECT_ENVIRONMENT`/`PYTHONPATH` (effective from the next campaign process). `compact_gate` now reads the verify JSON's `steps[].name/pass/ms` shape.
- 19:04 — Adaptation round 2: 11 min, 69 turns, **$1.67**. Root-caused browser-e2e: another process held Mailpit's default SMTP port 11025, `setup-infra` scanned to a free port (recorded in `.har/state/infra.env`), but `env.template` substitution only supports a fixed allowlist (AGENT_ID/API_PORT/FE_PORT/DEBUG_PORT/DB_PORT/MINIO_PORT/BROWSER_PORT/REPO_ROOT) — **no mailpit lanes** — so `.env.agent.1` kept the stale default and password-reset mails went nowhere. Workaround: `.har/hooks/post-launch.sh` patches `SMTP_PORT`/`MAILCATCHER_HOST` from `infra.env` and `pm2 restart --update-env`. → **HAR product finding #1: infra lane ports should be templatable in env.template (or exported to `.env.agent.<id>`).**
- Round 2 did not address the Python 3.13 vs 3.10 unit-test/mypy failures. The commit also shows a stock `lint` stage (`${NPM_BIN:-npm} run lint` at repo root) re-appearing in `stages.json` + `verificationStages` — Sonnet only ran `har env maintain --finalize` twice, so this looks like **maintain re-injecting a stock stage** (HAR product finding #2, to confirm). Gate round 2 running.
- 19:07 — **Gate round 2: full ❌** but progress: browser-e2e 41/41 ✅, `lint`(stock, re-added) ✅; remaining failures `unit-tests` (2 tests) and `backend-lint` (mypy) — both Python 3.13 vs 3.10. Round-2 final summary explicitly classified them as "pre-existing/upstream, deterministic given uv.lock" and only documented them; it did **not** pin the interpreter (the project's Dockerfile uses python 3.10) nor scope the tests out. Round 3 (last) running.
- Round-2 summary also confirms **finding #2**: "`har env maintain` re-adds this stock `lint` stage on every finalize run" (Sonnet removed it, `--finalize` re-injected it into `stages.json` + `verificationStages`).
- Runner policy change (effective next campaign process): after adaptation rounds are exhausted, a **soft gate** (doctor + launch + quick verify) decides whether the solve runs; `full_verify_ok` is recorded separately as harness quality. Rationale: requiring full green would drop from ARM A exactly the repos whose test suites are environment-sensitive, biasing the comparison toward easy-to-harness repos. The best-effort harness is now cached even when not fully green so the next commit continues from it instead of re-adapting from scratch.
- 19:13 — Adaptation round 3: 6 min, 37 turns, **$0.84**. Correctly attributed both failures to Python 3.13 (`unittest.mock` rejecting the `called_once_with` typo; mypy 1.19 `unused-ignore`) and scoped them out per the benchmark rule (no product edits): `stages/backend-tests.sh` runs pytest directly with two `--deselect`, new `stages/backend-lint.sh` passes only if `users.py:223 unused-ignore` is the sole mypy error, both documented under "Known pre-existing failures" in `.har/README.md`. Note: it still did not pin Python 3.10 (the project's Dockerfile does) — a stricter reviewer would call that the right fix. Cumulative adaptation so far: 3 rounds, ~46 min agent time, **$8.94**.
- 19:16 — **Gate round 3 ✅** (doctor, launch, quick, full). Harness cached: 29 files, 0 product files touched. Adaptation total for `fastapi__…-1396`: 3 rounds, 57 min wall (incl. 3 gates), $8.94. ARM A solve (Opus 4.8) started in worktree `~/worktrees/har-bench-base-bc7c-har-agent-1-iiop`.
- 19:17 — Flow validated, so **pilot campaign 2** started in parallel: `swebench-mm-dev`, `markedjs/marked`, first 2 instances by base-commit date (`marked-1262`, `marked-684`), both arms (`logs/campaign-marked.log`). Runs under the new soft-gate policy; campaign 1 (already in flight) still runs the strict-gate code. Parallelism noted: wall-clock metrics of concurrent sessions share CPU/network.
- 19:20 — **ARM A solve (Opus 4.8) done: 3.4 min, 17 turns, $0.54**, 11 shell commands, 1 `har env verify 1 --full`. Edited `backend/app/api/routes/users.py` (+404 after the 403 check) and added a new test file. Observations:
  1. Sonnet's tolerant `backend-lint.sh` matched the known mypy error by **exact line 223**; Opus's insertion moved it to 228 → stage red for an unrelated reason. Opus diagnosed it correctly (stashed, reran mypy on baseline) but this is a harness fragility (scoping out by line number). Product/methodology finding #3.
  2. `frontend/src/routeTree.gen.ts` was **already modified at session start** — HAR's launch (Vite + TanStack router plugin) regenerates it in the worktree. Launch side effects would leak into the graded patch. Runner fix: snapshot dirty files right after the gate/launch and exclude any that the agent left byte-identical (recorded as `launch_side_effect_files`).
- 19:22 — ARM A patch extracted (old code) contained `frontend/src/routeTree.gen.ts` (launch side effect, Opus did not touch it — confirmed in its final summary). Manually applied the new exclusion rule before scoring: `predictions/har.unfiltered.patch` keeps the original; `har.patch` now has only `backend/app/api/routes/users.py` + the new test file. Post-solve `har env verify 1 --full` = ❌ only because of the line-number-keyed `backend-lint.sh` (223→228), all other stages ✅. ARM B (raw) started 19:22.
- 19:24 — **ARM B solve (Opus 4.8, raw) done: 1.8 min, 18 turns, $0.47.** Same fix shape as ARM A (403 before 404) + a new test file. It provisioned its own environment: started a Postgres container, ran migrations + initial data, ran 27 tests green. For this small backend task the raw agent needed ~2 min of self-setup; HAR's pre-launched slot did not shorten the solve (3.4 min incl. a 2-min `verify --full`). Scoring started with the cleaned HAR patch.
- 19:24 — **Score, `fastapi-1396` ARM A: 0** (58/59 pass; F2P `test_get_non_existing_user_as_superuser` fails on `assert r.json() == {"detail": "User not found"}`). Opus returned 404 with `"The user with this id does not exist in the system"` — the string the same file already uses in `update_user`/`delete_user`. The problem statement (PR body) says only "Return 404 - Not Found when ID does not exist". **Dataset finding: hidden tests over-specify relative to the PR-derived problem statement** (message-string coupling). ARM B chose the identical string → will also score 0. This instance cannot separate the arms; it is a specification-ambiguity failure shared by both. To quantify in the full study: report "functionally correct but string-mismatch" as a secondary category (manual or LLM-assisted classification of failures).
- 19:25 — **Campaign 2 (`markedjs/marked`, cli profile): adaptation round 1 passed the gate first time** — 7 min, 73 turns, $1.47, 20 harness files, full verify ✅. ARM A solve started for `marked-1262`.
- 19:25 — **Score, `fastapi-1396` ARM B: 0** (same string mismatch). Instance result: A ✗ / B ✗; A cost $0.54 + $8.94 one-off adaptation; B cost $0.47.
- 19:26 — Stopped the campaign-1 process one minute into instance 2 (`1543`, cache hit, drift report running; orphan run dir `runs/20260910-172523-…-1543`, slot torn down) and **restarted it with `--resume`** so instances 2–3 run the corrected runner (soft gate, launch side-effect exclusion, `VIRTUAL_ENV` stripped). `1396` is skipped as completed.
- 19:26 — **`marked-1262` ARM A solve: 1.5 min, 9 turns, $0.38**, 1 `har env verify 1 --full` (all 5 stages ✅). Rewrote `splitCells` in `lib/marked.js`. Harness (cli profile, first-try gate): quick = `smoke` (node --check + require + CLI render) + `typecheck` (= `npm run build`), full = `unit-tests`, `lint` (eslint), `readiness`. Side effects again: `marked.min.js` regenerated by the build stage during the agent's own verify (legitimately part of the change for this repo), `package-lock.json` dirty at session start (launch side effect → excluded by the new rule if untouched).
- 19:27 — `marked-1262` ARM A patch (old extraction code, process started 19:17) contained the launch-side-effect `package-lock.json` (~180 KB). Applied the exclusion rule manually before scoring (`har.unfiltered.patch` kept). Kept `marked.min.js` (built from the agent's change by its own verify run; gold touches only `lib/marked.js`).
- 19:28 — **`marked-1262` ARM A: RESOLVED** (official swebench 5.0.2 grading, F2P 4/4). ARM B solve: 12 turns, $0.42, 1.2 KB patch → scoring.
- 19:29 — **`marked-1262`: A ✅ / B ✅.** A: 1.5 min, $0.38 (+$1.47 one-off adaptation); B: 1.6 min, $0.42 (raw arm ran `npm install` + `npm test` itself). Campaign 2 moves to `marked-684` (base commit 2018-12) → cache hit → drift check.
- 19:29 — **`marked-684` cache hit, gate passed unchanged** (doctor/launch/quick/full ✅ in 40 s) at base commit 2018-12-06 vs adaptation at 2018-05-08 (7 months of upstream drift). Drift-fix rounds: 0, setup cost: $0. ARM A solve started.
- 19:30 — **`fastapi-1543` cache hit, gate ❌ at `verify --full`**: 8/9 stages ✅ (incl. browser-e2e 41/41); only `backend-lint` ❌ because the known mypy `unused-ignore` moved from `users.py:223` to `:225` at this commit and the round-3 wrapper matches the exact line. Finding #3 confirmed as a **drift false positive**: a line-number-keyed exemption breaks on the very next upstream commit. Drift-fix round 1 (Sonnet 5, task-blind) started; cost of this fragility = one drift session.
- 19:31 — `marked-684` ARM A solve: 10 turns, $0.36, post-solve `verify --full` ✅. Patch again carried launch-side-effect `package-lock.json` (campaign-2 process predates the runner fix); excluded manually before scoring, original kept as `har.unfiltered.patch`. ARM B started.
- 19:34 — Drift-fix round 1 for `fastapi-1543`: 4 min, 15 turns, **$0.28**. Changed `backend-lint.sh` from an exact-line literal to a regex (`users\.py:[0-9]+: … unused-ignore`) — the durable form of the exemption. Gate re-running. (`manifest.json` also shrank by 26 lines: `maintain --finalize` rewrote checksums.)
- 19:34 — **`marked-684` ARM A: RESOLVED.** ARM B scoring (718-byte patch).
- 19:34 — **`marked-684`: A ✅ / B ✅. Campaign 2 done.** marked (SWE-bench MM dev, JS library, cli profile): 2/2 both arms, ≤1.6 min per solve, ≤$0.51 per solve. Adaptation: $1.47 once, cache reused with zero drift at +7 months. Conclusion for study design: the two oldest `marked` instances do not discriminate arms at Opus 4.8 capability — the full study must sample harder repos (Chart.js/p5.js browser-test repos, or the test split) and report per-difficulty strata.
- 19:37 — **`fastapi-1543` drift gate round 1 ✅** (all 9 stages). Instance-2 harness cost: 1 drift round, $0.28, ~11 min wall incl. two gates (vs $8.94 / 57 min for the first adaptation). Cache updated with the regex exemption. ARM A solve started.
- 19:39 — `fastapi-1543` ARM A solve: **6 turns, $0.22**, changed 400→403 in three `items.py` routes, ran `har env verify 1 --full` (all green except the 3 existing tests asserting 400, which it correctly identified as superseded by the task). Launch side effect `routeTree.gen.ts` **excluded automatically** by the new runner (patch = `items.py` only, 1576 B). → **`fastapi-1543` ARM A: RESOLVED.**
- 19:41–19:47 — **Incident: Claude Code usage limit.** The claude.ai plan hit its session limit ("You've hit your session limit · resets 8:30pm (Europe/Paris)"). Three solve sessions returned immediately with `is_error: true`, 1 turn, $0: `1543` ARM B, `2104` ARM A, `2104` ARM B. Their "unresolved" rows in `results.jsonl` are infrastructure failures, not agent attempts (kept for provenance; superseded by re-runs — the report takes the latest row per arm). The `2104` cache-hit gate itself passed unchanged (drift 0). Campaign 1 process ended 19:47.
- Runner fix: sessions with `is_error` (or non-zero exit without tool calls) are now recorded as `status=session_error`, never scored, and `--resume` re-runs them. **Paper note: run the full study on API-key billing, not a usage-capped plan.**
- 20:33 — Re-run `fastapi-1543` ARM B (raw): 9 turns, $0.24, 40 s, no environment setup needed for a status-code change → **RESOLVED**. Instance result: A ✅ / B ✅. Re-run of `2104` (both arms) started.
- 20:36 — `fastapi-2104` cache hit, **gate ✅ unchanged** (2nd consecutive zero-drift reuse for this repo). ARM A solve: **33 turns, $1.03, 6.2 min**, 3× `har env verify` (quick + full, all 9 stages green incl. new tests) + `har env status`. Task = real feature (pwdlib/Argon2 default, bcrypt auto-upgrade on login): edits `security.py`, `crud.py`, `pyproject.toml`, `uv.lock`, new `tests/core/`. Scoring will show whether the PrototypeBench scorer (`uv sync --frozen` in Docker) accepts an agent-modified lockfile.
- 20:48 — `fastapi-2104` ARM B (raw): **46 turns, $1.45, 4.7 min** (vs A: 33 turns, $1.03, 6.2 min incl. two full HAR verifies). Raw arm did `uv sync`, started a throwaway Postgres container, `alembic upgrade head`, ran the full suite (66 passed), ruff, mypy, then cleaned up its container. Both patches change `pyproject.toml` + `uv.lock` (pwdlib). Scoring both.
- 20:49 — **`fastapi-2104`: A ✗ / B ✗**, identical failure signature in both arms: 6× `TypeError: cannot unpack non-iterable bool object` — the hidden tests do `verified, _ = verify_password(...)`, i.e. the gold PR changed `verify_password` to return a **tuple** `(verified, updated_hash)`; both agents kept `bool` and added a separate `verify_and_update_password`. F2P 1/3 (the argon2-keeps-hash test passes), P2P 5 "regressions" that are really the same signature coupling. **Second spec-ambiguity failure (API shape) shared by both arms.** Also `1543` P2P included tests asserting the *old* 400 → the test_patch replaces them, fine.
- **Pilot tally after campaigns 1–2 (5 instances, 10 arm runs):** A 3/5, B 3/5, outcomes identical per instance. Two failures are dataset specification issues (message string; return-type), not agent or environment failures. Campaign 1 harness economics: $8.94 + 57 min once, then $0.28/11 min and $0/3 min for the next two commits (2 of 3 cache reuses passed the gate untouched).
- 20:50 — **Campaign 3 started:** `IBM/mcp-context-forge`, first 2 instances by base date (`3262`, `3297`), both arms (`logs/campaign-mcp.log`). Full backend suite is 31.5k tests (`pytest -n auto`) — first real stress of the gate timeout (30 min) and of the default-profile adaptation on a large FastAPI service.
- 20:51 — `--infra-down` had no effect: HAR names its compose project `har-<HARNESS_PROJECT_NAME>`; runner passed the bare name (exit 0, nothing matched). Fixed `infra_down` to try both; stopped `har-fastapi-full-stack` (db + mailcatcher) manually. Campaign-1 monitor stopped.
- 21:04 — Campaign 3, `mcp-context-forge-3262` adaptation round 1: 14 min, 114 turns, **$4.40**. Default profile, primary app `mcpgateway`, health `/health`, `HARNESS_ECOSYSTEM=python`, **no infra services** (tests default to in-memory SQLite, matching the PrototypeBench source config), quick = `compileall` + api-health, full = `pytest -n 16 --ignore tests/fuzz --ignore tests/e2e…` + `flake8` + readiness. No Playwright plugin for the admin UI. This time **zero** reads of HAR's `dist/index.js` (contrast: 21+12 on the template repo). Gate running — first heavy full suite (~31k tests) against the 30-min gate timeout.
- 21:11 — **Gate round 1 (`mcp-3262`) ❌ at `unit-tests`** (209 s, `pytest -n 16`): typecheck/api-health/lint (148 s flake8)/readiness ✅. The stage output in `har env verify --json` **and** in the `.har/runs/…_verify_agent-1.json` record is truncated from the head: it stops at "[ 25%]" with two `F` markers visible and no pytest summary, so the failing test ids are unrecoverable from HAR's own evidence. **HAR product finding #7: stage output capture keeps the head and drops the tail — the opposite of what diagnosis needs; write the full log to `.har/artifacts/<stage>/` and keep the tail in the JSON.** The round-2 adapter gets the same truncated context and must re-run the suite itself.
- 21:51 — `mcp-3262` adaptation round 2 **timed out at 40 min** (session killed; no result event → cost unrecorded, est. $3–5). 45 tool calls, 18 pytest invocations, 5× `har env verify`, hunting the failing/flaky tests in a 31k-test suite where one `verify --full` costs ~6 min. Net change: 2 lines in `stages.json` (see below). **Finding #8: adaptation iteration speed is bounded by full-suite duration** — for large suites the adapter needs a fast "targeted rerun" path (e.g. HAR stage `--last-failed`) or the budget must scale with suite size. Gate round 2 running.
- 21:57 — **`mcp-3262` gate round 2 ✅** (typecheck, api-health, unit-tests ~3.5 min, lint, readiness). Adaptation total: 2 rounds, ~68 min wall, $4.40 recorded + one unrecorded timed-out session. Harness cached; ARM A solve started.
- 21:59 — `mcp-3262` ARM A solve: 12 turns, $0.56, 1.3 min, **0 `har` commands**. Template-only fix (`pagination_controls.html`, move query params into a `data-extra-params` attribute). Agent wrote: "The project's own venv wasn't reachable to run `make test`/`make lint` here" and verified by rendering the template with Jinja2 — it **did not use `har env verify 1`** despite the env note and `AGENTS.md`. Behavioural finding: HAR usage is not guaranteed by instructions alone; track `har_commands=0` solves as "harness ignored". Runner side effect spotted: the pre-solve dirty snapshot staged untracked files (`git add --intent-to-add`), so the agent saw `A mcp_agent_1.db-shm/-wal` (slot SQLite files) in `git status`. Fixed: snapshot is now read-only.
- 22:03 — `mcp-3262` ARM A patch (new code) still contained the slot's SQLite `mcp_agent_1.db-shm/-wal`: they were pre-solve dirty but their **content changed** during the post-solve verify (the running app writes them), so the byte-identical rule did not fire. Excluded manually before scoring (`har.unfiltered.patch` kept). Runner rule tightened: a pre-solve-dirty file is excluded unless the agent edited it with a file tool (paths taken from the transcript) — content hash alone is not enough for live data files. Post-solve `verify --full` ❌ for ARM A (see next line).
- 22:04 — `mcp-3262` ARM A post-solve `verify --full`: `unit-tests` ❌ (typecheck/api-health/lint/readiness ✅), 6 min after the same suite passed the gate on the same harness, with only a template edit in between. Either the template change broke a test or the suite is flaky at `-n 16`; the truncated output (finding #7) prevents telling which. Score will arbitrate.
- 22:05 — **Operator stop for reboot.** Campaign 3 process killed while scoring `mcp-3262` ARM A; both solve sessions had completed (A: 12 turns $0.56, B: 11 turns $0.52) and both patches are on disk (`har.patch` cleaned, `raw.patch`). Slot 1 torn down, no worktrees/containers left. Nothing restarted.

### How to resume (after reboot), from `benchmarks/saas-har`
1. `uv run scripts/rescore.py --run-id 20260910-185008-ibm-mcp-context-forge-3262` — grades the two saved patches (Docker must be up).
2. `uv run scripts/run_campaign.py --datasets newtypebench --repos IBM/mcp-context-forge --limit-per-repo 2 --arm both --resume` — runs `mcp-3297` (cache hit expected, drift gate) and skips `3262` once step 1 has written its rows.
3. `uv run scripts/report.py` → `results/REPORT.md`; then update §5 of `PILOT-REPORT.md`.
Optional next samples: `--repos chartjs/Chart.js --limit-per-repo 2` (browser-test repo) for `swebench-mm-dev`.

## 2026-09-10 (evening) — protocol v2

Decision (operator): the raw arm must receive **only** the dataset's task text. Starting the app,
running tests and verifying are exactly what HAR provides, so telling the raw arm to do them
imports HAR's workflow into the baseline and hides the effect we want to measure. Full spec and
v1→v2 diff: `PROTOCOL.md`.

### What changed
- **One prompt for every arm**: repo + commit + `problem_statement`, nothing else. `prompts/env-har.md` and `prompts/env-raw.md` deleted; the v1 wording survives as `prompts/ablation-verify.md` for ARM B′ (`--arm raw_verify`), so "HAR" can be separated from "we told it to verify".
- **No pre-launched slot.** The runner's readiness gate still launches and verifies (task-blind quality control), records what launch dirties, then tears the slot down. The solving agent finds an un-launched repository and decides for itself; HAR's own `AGENTS.md` / `.har/README.md` / Claude skills are the only guidance.
- **Patch discovery**: slot worktree → session branch ahead of the harness commit → main checkout; a stash is popped if the tree looks empty. Raw diffs are saved next to every graded patch (`*.raw.patch`) so filters can change without re-running agents.
- **Behaviour is now the primary outcome** (`scripts/lib/behaviors.py`): installed deps, started services, ran tests, ran build/lint, verified anything, committed, test files edited, and for ARM A `har env launch` / `verify` / `verify --full`.
- **Leak removal**: checkouts moved to `~/agentbench-work/<sha1(run_id)[:10]>/{a,b,b_prime}/repo` (no "har", no "bench", no instance id in any agent-visible path); base branch `task-base`; harness commit `chore: development environment setup` by `dev <dev@localhost>`. Motivation: the v1 raw agent named its Postgres container `har_pg`, which it could only have read from its cwd.
- **Unattended safety**: usage-limit detection now waits `usage_limit_wait_minutes` and retries (`usage_limit_retries`); one runner per machine enforced by an flock on `results/.runner.lock`.
- `results.jsonl` rows carry `protocol`; `report.py` groups by protocol and prints behaviour rates. v1 rows are kept and never pooled with v2.

### v2 smoke test — `markedjs__marked-684`, both arms
- **The key validation: with no instruction whatsoever, the ARM A agent ran `har env launch 1`, worked in the slot worktree, and ran `har env verify 1 --full`** (3 har commands, 22 turns, $0.58, 1.0 min). ARM B installed deps and ran `npm test` itself (29 turns, $0.84, 1.5 min). Both produced a correct fix; both resolved.
- Mechanism check: writing outside the session cwd works under `--dangerously-skip-permissions` (probed separately), so ARM A needs no extra flag — and therefore no hint — to use a worktree.
- Incident: I launched the smoke test twice by accident (the first `nohup` survived a failed `tail` in the same command line). Two runners contended for HAR slot 1; the second run lost its worktree mid-session and fell back to `patch_source=session_branch`. Killed it, marked its run dir `INVALID-concurrent-…`, and added the runner lock so this cannot recur. The surviving run (`work_id f47356728a`) is the clean data point.
- **Finding: both arms edited the graded test corpus.** ARM A added a case to `test/specs/marked/marked.json` and ARM B added `test/new/list_after_list.{html,md}` — the very files whose entries the FAIL_TO_PASS names index into. Under v1 a prompt rule ("do not modify existing test files") suppressed this; v2 has no rules, so the runner must handle it as scoring mechanics: test-suite paths are now excluded from every graded patch (mirroring SWE-bench, which resets test files before applying `test_patch`, and the PrototypeBench reference runner, which strips `*test*` from the agent diff) and recorded as behaviour (`test_files_edited`, `test_paths_excluded`).

### v2 pre-flight — `markedjs__marked-1262`, both arms (full unattended path)
- **ARM A launched a slot and ran `verify --full` again, unprompted** (26 turns, $0.84; 3 har commands; post-solve verify green). ARM B: 19 turns, $0.64, no services, no test run this time. Both **resolved**.
- The live path did what the refilter had to do by hand for the smoke run: `package-lock.json` excluded as a gate-recorded launch side effect ("changed by the environment"), the agent's `test/unit/marked-spec.js` edit excluded as a test path. Graded patch = `lib/marked.js` + `marked.min.js`.
- Work dir cleaned automatically after scoring (47 MB freed, 34.4 GB free). Scorer workspaces are per-arm and deleted with a root-capable delete (the upstream scorer's container writes root-owned `.venv`/`.pytest_cache`, so a shared workspace would break its own `git clean` — measured, then reverted to per-arm).
- **Fairness fix found here**: ARM B's own `npm install` rewrote `package-lock.json` (147 KB patch) while ARM A's identical churn was excluded via the gate baseline — an asymmetry that would have penalised ARM B. Rule now applied to **every** arm: a dependency lockfile is dropped from the graded patch unless its manifest changed in the same patch (`orphan_lockfiles_excluded`). `fastapi-2104`-style changes (pyproject.toml + uv.lock together) are unaffected. Unit-tested.
- Housekeeping: v1 checkouts and old scorer workspaces removed (`runs/` 4.7 GB → 19 MB, free 31 → 35 GB).
- All four v2 arm results re-graded under the final rules: `marked-1262` A ✓ / B ✓, `marked-684` A ✓ / B ✓.

### Overnight plan
Written to `OVERNIGHT-PLAN.md` with `scripts/overnight.sh` (5 phases, ~7 h, ~$47, sequential, `--resume`). **Not started — awaiting approval**, plus two operator decisions: billing (subscription with retries vs `ANTHROPIC_API_KEY`) and whether to `docker builder prune -f` first (~30 GB reclaimable).

## 2026-09-11 — protocol v2 campaign launched

- 00:41 local — `scripts/overnight.sh` started (log `logs/overnight-20260911-0041.log`), 5 phases,
  code frozen at the state that passes the 10 protocol tests. Phase 1a skipped both `marked`
  instances (already completed under v2), phase 1b began with `fastapi-1396`.
- Decisions at launch: existing session auth (usage-limit wait/retry, no API key added); no Docker
  prune (disk had risen to **225 GB free**, so the Chart.js phase is no longer disk-constrained);
  **one attempt per arm** — repeats deferred to a separate campaign.
- Interpretation limits and the post-campaign analysis backlog are recorded in `PILOT-REPORT.md`
  ("Interpretation: what this design can and cannot support") so the paper's caveats predate the
  numbers: single attempt per instance (effect-size estimate, not a hypothesis test), binary rows
  (per-test data stored but not surfaced), `ran_tests` under-reporting ARM A because its suite runs
  inside `har env verify`, `read_harness_docs` invalidated by automatic CLAUDE.md context, no
  failure taxonomy or paired statistics yet, contamination asymmetry between the two datasets, the
  extra harness commit in ARM A, and bruno's ungraded frontend instances.
- 00:50 — Built `scripts/analyze.py` (new file only; the running campaign's code path untouched). It computes the whole analysis backlog from stored artifacts: per-test F2P/P2P counts from each scorer, **effective verification from HAR's `.har/runs` stage records** (the fix for `ran_tests` under-reporting ARM A), verification dynamics (checks, post-check edits, check→edit cycles), gold-patch file/line overlap, difficulty strata from the gold patch, a first-pass failure taxonomy, and paired statistics (exact McNemar + Wilson intervals). Verified on the two graded v2 instances: ARM A "project checks actually ran" 2/2 (evidence: `typecheck`, `unit-tests`, `lint` stages) vs ARM B 1/2, while the naive transcript metric said 0/2 vs 1/2.
- Note for the paper: HAR run records also capture that the ARM A agent bound work metadata at launch (`workUnitId: marked-table-escaped-pipe`) without being asked — provenance the raw arm cannot produce.
- 01:17–01:27 — `mcp-3262` (cache hit): gate ❌ at `unit-tests` (104 s, output truncated from the head — finding #7 again), one drift session ran (24 turns, $0.55), then gate ✅. **The drift session changed nothing**: the only commit in the harness root is the original `chore: development environment setup`. So the 31k-test suite at `-n 16` is **flaky**, and the second gate simply re-ran it green.
  - Consequence for the study: on this repository `har_ready` and `full_verify_ok` are noisy measurements, and flakiness can consume a drift round (~$0.55, ~10 min) with no change. Report gate outcomes for mcp-context-forge with that caveat; consider `-p no:randomly`-style determinism or a retry-once policy for the stage in a future adaptation.
  - Observed: the drift agent's final message was "I'll stop here and wait — the background wait command will notify me automatically once the pytest run finishes", and the session ended there with its work unfinished (the runner treated it as complete). No damage — the gate re-ran and passed. **Initially recorded as product finding #9 ("a headless session cannot be woken"); CORRECTED at 03:10 — see the `mcp-3325` entry: a background task *does* re-invoke a headless `-p` session, and the transcript then carries two `result` events.** The real issue is narrower: a session that stops while waiting is only resumed if a background task is still pending, so an agent that mis-times the wait can end early and silently. Runner guard (post-campaign): treat "final text says it is waiting" + no further result event as a truncated session, and re-prompt once.
- 01:51 — **`mcp-3262` ARM A solve: 24 min, $3.32, 61 tool calls** (the harness reports `num_turns: 1` because it was one long turn). It invoked HAR's own installed skill (`har-wt`), ran 6 `har` commands including `verify --full`, committed in the slot, and produced the right one-file fix (`mcpgateway/templates/pagination_controls.html`, same as the v1 run). Post-solve verify green. Slot SQLite files and a test-file edit excluded automatically.
  - It also used `Monitor` **7 times** to wait for the 6-minute suite, then ended with: *"The implementation is complete and verified; I'm waiting for your direction on any next steps (push, PR, or teardown)."* That is HAR's `AGENTS.md` handoff protocol working as designed — and in an unattended benchmark it costs wall clock and tokens. **Product finding #10: the handoff instruction makes an autonomous agent idle at the end; HAR should say what to do when no human is present** (or the benchmark must strip that instruction, which would break the "repository alone" rule — so it belongs in HAR).
  - Analysis consequence: ARM A's session wall clock and cost are inflated by harness-instructed waiting, not by extra work. `scripts/analyze.py` now records `checks`, `waits`, `waiting_calls_after_last_action` and `handoff_idle` per session so cost/time can be reported with and without the handoff tail. On this session: 11 checks, 7 waits, idle at handoff.
- 01:55 — ARM B on the same instance: 6 turns, $0.33, **no tests, no services** — a 10× cost gap in the opposite direction. Scoring decides whether verification was worth it here.
- 02:05 — **`mcp-3262`: A ✅ / B ✅.** Same correct fix from both arms. ARM A: $3.32, 24 min, verified through the harness, committed. ARM B: $0.33, 4 min, no tests run at all. **On this instance verification bought nothing measurable and cost 10×.** Recorded as-is: the harness's value has to show up on tasks where an unverified guess fails, and this template one-liner was not one of them.
- 02:31 — **`mcp-3297`: A ✗ / B ✗ on the binary score, but the arms are not equal.** Both edited the same file (`mcpgateway/admin.py`), both regressed nothing (0 of 918 PASS_TO_PASS), and the target tests split: **ARM A 10/12, ARM B 8/12**, with ARM B missing a strict superset of ARM A's misses (it additionally failed `test_admin_tool_ops_partial_uses_resolve_root_path` and `test_admin_users_partial_html_controls_uses_resolve_root_path`). Both missed the same two edge cases (scheme-relative `//`, whitespace-only scope). Cost: A $1.29 / 30 turns, B $0.88 / 20 turns (B ran tests itself this time).
  - **First evidence that binary scoring hides a difference between the arms** — and the reason the analysis layer surfaces F2P counts. A study reporting only resolve rates would score this pair as a tie.
- 03:03 — **`mcp-3325` ARM A: 37 turns then 4 more, $1.66 total, resolved-looking handoff.** The transcript carries **two `result` events**: the model stopped saying "now let me wait for the full harness verification to complete", the background verification finished, and **Claude Code re-invoked the session**, which then produced a proper HAR handoff (session branch `task-base-8d8c6-har-agent-1-ovod`, commit, preview URL, "not pushed / no PR, per instructions").
  - **This corrects product finding #9**: a headless `claude -p` session *can* be resumed by a background task completing. Two consequences for the runner: (a) `summarize_transcript` must keep reading to the **last** `result` event (it does — `run.json` reports the 4-turn continuation, cost $1.66; a naive first-match parse would have reported 37 turns / $1.47), and (b) the per-session cost/turn figures are the sum across continuations, which the harness already aggregates.
  - Methodological note: the agent wrote a deterministic guard test, confirmed it fails without the fix and passes with it, then ran full verification — the closest thing yet to the behaviour HAR is meant to induce.

### Phase 2 complete — `IBM/mcp-context-forge`, 6 instances (04:26)
Backend pool, 9 paired instances including the FastAPI template:

| instance | A | B | A F2P | B F2P | A cost | B cost | note |
|---|---|---|---|---|---|---|---|
| mcp-3262 | ✅ | ✅ | 1/1 | 1/1 | $3.32 | $0.33 | identical patches; A idled at handoff |
| mcp-3284 | ✅ | ✅ | 1/1 | 1/1 | $0.62 | $0.32 | identical patches |
| mcp-3325 | ✅ | ✅ | 1/1 | 1/1 | $1.66 | $1.54 | A wrote a guard test, confirmed red→green |
| mcp-3297 | ❌ | ❌ | **10/12** | **8/12** | $1.29 | $0.88 | only test-level difference of the night |
| mcp-3307 | ❌ | ❌ | 1/4 | 1/4 | $2.00 | $1.25 | hard: scoped-token wiring; both fell short |
| mcp-3269 | ❌ | ❌ | 3/20 | 3/20 | $5.22 | $4.00 | 6 files + Alembic migration; tests pinned to constraint names |

**Paired outcome across the 9 backend instances: A 4/9, B 4/9, zero discordant pairs.** No
resolution-rate effect, and with no discordance no test is computable. Every unresolved pair is
"partial: some target tests pass" with **zero PASS_TO_PASS regressions** (out of 18–918 tests per
instance) except `fastapi-2104`'s five signature-coupled ones — i.e. no arm produced a broken or
empty patch anywhere in the phase.

Behaviour, by contrast, separates cleanly: **environment provisioned 9/9 (A) vs 4/9 (B)**; install
command typed 1/9 (A) vs 4/9 (B); every A session launched a slot and ran `har env verify`.

Cost: A is consistently more expensive (median ≈1.7×, worst 10× on mcp-3262 where the handoff
tail dominated). Gold-patch line overlap slightly favours A on 4 of 5 unresolved pairs.
- 04:45–04:49 — **First genuine drift (not flakiness): `marked-1535`.** Harness adapted at the 2018-05 commit, gate now failed at the 2019-08 commit on `lint`: the 2018 adaptation pinned `eslint --no-eslintrc --config .eslintrc.json` (to stop ESLint 4 walking up to an unrelated ancestor config), which also blocks the nested `test/.eslintrc.json` the project added when it moved its tests to ES6 — so ESLint rejected `const` as reserved in every test helper. One drift session (27 turns, **$0.53**, ~3 min) removed the pin and matched the project's own `test:lint` script (`eslint bin/marked .`); the gate passed immediately. **Cost of following 15 months of upstream evolution: one session, half a dollar.** This is the cache+drift design working as intended, and a cleaner example than the mcp flakiness case.
- 05:08 — **First discordant pair of the campaign: `marked-1683` A ✅ / B ❌.** Task: escaped characters breaking image links. **ARM A fixed two files** (`src/rules.js` regex + `src/Tokenizer.js` logic) and its `verify --full` passed; **ARM B fixed only `src/rules.js`**, ran the suite itself (`ran_tests: True`), and still failed the single target test (`New image_links should pass`), zero regressions. Cost A $1.28 / 32 turns vs B $0.71 / 23 turns.
  - Notable: B *did* verify in its own way and still shipped an incomplete fix, so the difference is not simply "A tested and B did not" — A's harness-driven full verification (build + unit + lint on the real project scripts) surfaced enough to find the second required file. n=1, but it is the first case where the environment plausibly changed the **outcome** rather than only the cost.
- 05:36 — **Second discordant pair: `marked-1889` A ✅ / B ❌** (whitespace-only lines removed inside code blocks). ARM A changed **4 files** (`Lexer.js`, `Renderer.js`, `Tokenizer.js`, `rules.js`), ARM B changed **2** (`Lexer.js`, `rules.js`) and failed the target test, zero regressions, patch applied cleanly. B ran tests itself. Cost A $1.40 / 39 turns vs B $0.83 / 24 turns.
  - **Both discordant pairs to date share a shape: the raw arm produces a narrower, incomplete multi-file fix.** `marked-1683` (2 files vs 1) and `marked-1889` (4 files vs 2). Hypothesis to test in the analysis: the harness's full verification (project build + unit + lint) exposes the parts of a multi-file change that a hand-rolled test run misses. Still n=2 discordant out of 18 pairs — report as a direction, not a result.
- 05:46–05:49 — **Structural drift caught by the *quick* tier: `marked-2483` (2022 commit, harness from 2019).** `smoke` failed in 24 ms — `node --check lib/marked.js` → MODULE_NOT_FOUND, because the project moved its build output. One drift session (27 turns, **$0.47**, ~2 min) updated three stages to match 3 years of upstream change: smoke → `lib/marked.cjs` + `bin/marked.js`, lint → the project's current `eslint .`, build/"typecheck" → rollup `src/marked.js` → `lib/marked.umd.js` then uglify. Gate passed immediately.
  - Design note for the paper: the **cheap quick tier acted as the tripwire** (24 ms to detect) before any heavy stage ran, and the drift agent had to read the project's own scripts to repair it. Cumulative drift cost on `marked` across 2018→2022: **2 sessions, $1.00**, for 14 instances.
- 05:57 — **Third discordant pair: `marked-2483` A ✅ / B ❌**, and it breaks the emerging pattern. Both arms edited **the same single file** (`src/Tokenizer.js`), yet A passes **3/3** target tests and B passes **0/3** (no regressions either side, both patches applied). Task: fences/headings following a list. So this is not "A edits more files" — it is a correctness difference inside one file. B ran tests itself. Cost A $1.04 / 22 turns vs B $0.82 / 16 turns.
  - Revised reading: the three discordant pairs (`1683`, `1889`, `2483`) do **not** share one mechanism; two were narrower multi-file fixes, one is a wrong single-file fix. What they share is only that ARM B stopped earlier (16–24 turns vs 22–39) — consistent with "the harness pushes the agent to keep going until the project's own checks pass", but that is an inference from n=3 and should be stated as such.

### Phase 3 complete — `markedjs/marked`, all 14 dev instances (06:20)
**A 11/14 vs B 8/14. Three discordant pairs, all A✅/B❌ (`1683`, `1889`, `2483`), none the other way.
Exact McNemar p = 0.25** — a consistent direction, not significance, which is exactly what 3
discordant pairs can carry. Zero PASS_TO_PASS regressions anywhere in the phase, both arms.
- Project checks actually ran: **14/14 (A) vs 11/14 (B)**; `har env launch` + `verify --full` 14/14 in A.
- Drift across 2018→2022: 2 sessions, $1.00 total, both repairs maintainer-grade (see 05:46 and 04:45 entries).
- Campaign so far (both datasets, 23 pairs): **A 15/23, B 12/23; 3 discordant, all favouring A, 0 against.**
  The asymmetry is the most interesting number of the night — and the one most vulnerable to the
  single-attempt limitation, since with n=1 per instance I cannot separate it from run-to-run variance.
- 06:22 — Phase 4 (B′ ablation) started. First data point (`marked-1262`): with the v1 "set up and
  verify" instructions, the raw arm still **did not run tests** (21 turns, $0.66).
- 06:43 — **Ablation hits the first discordant instance and recovers it: `marked-1683` B′ ✅** (plain B was ❌). B′ edited **the same two files** as A (`Tokenizer.js` + `rules.js`; plain B edited one) and used **35 turns vs B's 23**. First direct evidence that the v1 "set up and verify" instruction alone can buy what the harness bought on that instance — i.e. the mechanism looks like *verification discipline*, not something unique to a HAR slot. Watch `1889` and `2483`.
- 06:48 — **Ablation reversal: `marked-1739` B′ ❌** where both A and plain B had resolved it. B′ edited `src/rules.js` **plus three build outputs by hand** (`lib/marked.js`, `lib/marked.esm.js`, `marked.min.js`) and still failed the single target test (0/1, no regressions, patch applied). A and B had touched source only and let the build regenerate.
  - Two readings, both worth reporting: (a) **run-to-run variance is material at this n** — direct evidence for the single-attempt limitation, and a caution against over-reading the 3–0 discordance; (b) the "set up and verify" instruction can push a session into **patching generated artifacts**, i.e. instructions change behaviour in both directions, whereas the harness supplies the project's real build/test pipeline along with the nudge.
- 07:01 — **Ablation fails the second discordant instance: `marked-1889` B′ ❌** (A ✅, B ❌). B′ spent **39 turns — exactly A's count, vs plain B's 24** — and still edited only **2 files** (`Lexer.js`, `rules.js`) where A edited 4. So on this instance the instruction bought the *effort* but not the *coverage*.
  - Ablation scorecard on the three discordant instances so far: `1683` recovered ✅, `1889` not recovered ❌, `2483` pending. Plus one instruction-induced regression (`1739`, hand-edited build outputs).
  - **Honest reading: instructions buy part of the effect, not all of it, and they can backfire.** "HAR is just a verify nudge" is not supported, but neither is a clean harness-specific mechanism at this n.
- 07:09 — **Ablation verdict on the discordant set: `2483` B′ ❌** (A ✅, B ❌; B′ edited the same single file `src/Tokenizer.js` as both, 29 turns vs A's 22 and B's 16). Final scorecard on the three A✅/B❌ instances: **B′ recovered 1 of 3** (`1683`), failed `1889` and `2483`, and separately **broke one instance that both A and B had solved** (`1739`, hand-edited build outputs).
  - Conclusion the ablation supports: the "set up and verify" instruction recovers **part** of the gap (~1/3 of the discordant cases), does not reproduce it, and can backfire. **"HAR is just a verify nudge" is not supported**; equally, the harness advantage stays small and statistically unproven at this n.

### Phase 4a complete — B′ ablation on all 14 `marked` instances (07:19)
| arm | resolved | mean cost | total cost |
|---|---|---|---|
| A (HAR) | **11/14** | $1.09 | $15.24 |
| B (raw) | 8/14 | $0.90 | $12.56 |
| B′ (raw + v1 verify instruction) | **8/14** | $0.97 | $13.58 |

**B′ ties B in aggregate but on a different instance set**: +`1683`, −`1739`. So on this pool the
"set up and verify" instruction **reshuffles** which instances succeed without raising the rate,
while A sits 3 above both at ~20% more cost. This rules out the simplest competing explanation
("HAR ≈ a verify nudge") *for this pool*, and simultaneously shows A's edge is not significant at
n=14 (McNemar p = 0.25 on 3 discordant pairs).

### Phase 4 complete — full three-arm comparison, 23 instances (08:22)
| arm | resolved | total solve cost |
|---|---|---|
| A (HAR) | **15/23** | $31.43 |
| B (raw) | 12/23 | $22.88 |
| B′ (raw + v1 verify instruction) | **12/23** | $27.02 |

- **B′ = B in aggregate (12/23) at 18% higher cost**, and vs A it loses 3 instances (`marked-1739`, `1889`, `2483`) and wins **none**. The "HAR is just a verify nudge" explanation is directly contradicted.
- The entire effect is in one pool: `marked` **11 / 8 / 8**; backend (`mcp-context-forge` + fastapi template) is flat **4 / 4 / 4** at n=9.
- Test-level, the backend pool tells a different story than the binary: B′ matched A on `3297` (10/12 vs A 10/12, B 8/12) and **beat both** on `3307` (2/4 vs 1/4). On `3269` all three arms landed on exactly **3/20** despite $5.22 / $4.00 / $5.95 — three independent attempts converging on the same partial score means that instance measures the dataset's constraint-name specificity, not the environment.
- A's advantage: confined to one repository, 3 instances, McNemar p = 0.25. Report as a direction with an effect size, never as a demonstrated improvement.

### Phase 5 — `chartjs/Chart.js`, fresh task-blind adaptation (08:22–08:45)
- **Adapted on round 1**: 21 min, 119 turns, **$3.54**, gate green first try. The adapter re-scaffolded to the **`cli` profile** (right call for a library), and solved the browser problem properly: `HARNESS_INSTALL_CMD` fetches Chromium via `npx playwright install chromium` into a slot-local `.har-playwright-browsers`, and `stages/unit-tests.sh` points karma's chrome launcher at the versioned binary with a diagnostic that names the launch step if it is missing. Stages: quick = `lint-tsc` + `build`, full = karma `unit-tests` + `lint`.
- `Chart.js-7951` (borderRadius for bar elements): **A 66 turns / $3.63, launched + ran the real karma suite**. **B 43 turns / $1.43, ran nothing** — its own summary: *"the repo's dev dependencies aren't fully installed here, so I couldn't run the Karma/rollup pipeline; I verified all files pass `node --check` … the fixture-based visual regression tests would need PNG goldens generated in a browser environment."*
- This is the stratum the campaign was missing: a repo where the raw arm **cannot cheaply build a test environment** and says so explicitly.
- 09:08 — **First discordance AGAINST the harness: `Chart.js-7951` A ❌ / B ✅.** The graded test is a **pixel fixture** (canvas render vs a committed PNG golden). A edited 6 files including `src/helpers/helpers.canvas.js` (the shared drawing helper) and broke the fixture; B — which could not run anything — edited only the bar element + options and happened to match the reference rendering. F2P A 0/1, B 1/1, no P2P regressions either side.
  - **The verified arm lost *because* it went further; the unverified arm won by being conservative.** Running the karma suite showed A its own new tests passing while saying nothing about the committed goldens. Honest limitation to report: local verification does not constrain pixel-comparison oracles, and on this class of task it can *encourage* over-reach. This is the counter-example to the `marked` story and must be reported with equal weight.
- 10:04 — **Most expensive session of the campaign: `Chart.js-8567` ARM A, 158 turns, 33 min, $13.59.** Not idling — 28 edits, 82 shell commands, **16 edits after its first check**, 3 full verifies ending green (typecheck, build, **1252 karma specs**, lint), `handoff_idle: False`. It also corrected a stale expectation in an existing spec (the y-axis max tick `70` did not cover the data max `78`).
  - Clearest example of the harness enabling an **iterate-against-real-tests loop** — and the clearest example of that loop's **cost**: one instance at $13.59, ~9× the campaign's median ARM A solve.

### Campaign closed 10:46 (2026-09-11)
26 paired instances + 23-instance ablation, 4 repositories, ~10 h wall clock, **$50.91 (A) +
$29.36 (B) + $27.02 (B′) solve cost + $20.18 harness adaptation ≈ $128 total**.
Final numbers, per-repo breakdown, behaviour table, ablation verdict, counter-example, failure
taxonomy and economics are written up in `PILOT-REPORT.md` → "Protocol v2 campaign — results".
Headline: **behaviour demonstrated (26/26 launch+verify, evidenced in `.har/runs`), outcomes not
demonstrated (17/26 vs 15/26, McNemar p = 0.625, effect confined to `marked`, reversed on the
Chart.js pixel oracle), mechanism not reducible to a verify instruction (B′ = B at +18% cost).**
No arm ever produced an empty patch, timed out, or failed to apply a patch.

### Product findings for HAR (from the adaptation + solve transcripts)
1. `env.template` cannot template infra lane ports (mailpit) → stale `SMTP_PORT` in `.env.agent.N`; worked around with a `post-launch.sh` hook.
2. `har env maintain --finalize` re-adds a stock `lint` stage on every run, even after the adapter removed it as a duplicate.
3. The scaffold's docs did not answer the adapter's questions: it read HAR's compiled `dist/index.js` 21+12 times on the first repo (0 times on later ones).
4. No toolchain pinning: the default profile ran a Python-3.10 project under host Python 3.13; two pre-existing tests and mypy failed only for that reason.
5. Adapters express "known pre-existing failure" exemptions by exact line number; one broke on the very next upstream commit and cost a drift round.
6. Compose project naming is `har-<HARNESS_PROJECT_NAME>` — external tooling must know the prefix to stop infra.
7. **Stage output is truncated from the head**, so a failing 31k-test suite shows "[ 25%]" and no summary; the failing test ids are unrecoverable from HAR's own evidence. Write the full log to `.har/artifacts/<stage>/` and keep the *tail* in the JSON.
8. Adaptation iteration speed is bounded by full-suite duration (one `verify --full` ≈ 6 min on mcp-context-forge); large suites need a targeted-rerun path or a budget that scales with suite size.
9. *(corrected)* A headless session **can** be resumed by a background task completing — the transcript then carries two `result` events, and metrics must read the **last** one.
10. **The `AGENTS.md` handoff protocol makes an autonomous agent idle at the end** ("waiting for your direction on push/PR/teardown"): correct for humans, wasted wall clock and tokens in an unattended pipeline. HAR should say what to do when no human is present.

### 2026-09-11 — Did the arms write tests? And a contamination finding
Both arms frequently wrote their own tests; **neither could ever see the graded ones** (the dataset's
test patch is applied only at score time, so the FAIL_TO_PASS cases are absent from the working tree
for the whole session). Agent-written tests are stripped from the graded patch by design and recorded
as `test_files_edited` / `test_paths_excluded`.

Test-writing on the three A-only discordant instances:

| instance | A tests written | B tests written | outcome |
|---|---|---|---|
| `marked-1683` | 2 | 2 | A ✅ / B ❌ |
| `marked-1889` | 5 | **0** | A ✅ / B ❌ |
| `marked-2483` | 2 | 2 | A ✅ / B ❌ |

So test-writing effort explains at most one of the three. On `1683` the raw arm wrote a case, ran
`npm test` **more times than ARM A did**, finished green at **1537 specs / 0 failures**, and still
failed the hidden case — its self-written test encoded a narrower reading of the bug (escaped alt
text, no bracketed title; the graded case had both). Local green was accurate about what it covered
and silent about what was graded.

**Contamination evidence (important, and it lands on the pool where ARM A "wins").**
On `marked-1889` the maintainer's test patch **creates** `test/specs/new/whiltespace_lines.{html,md}`
— note the typo, "whiltespace". That string appears nowhere at `base_commit`, nowhere in the problem
statement, and nowhere in the hints. **ARM A independently created a file with exactly that
misspelling.** Chance is not a plausible explanation: this is memorisation of the upstream 2020
commit. 16 of 47 test-writing sessions reproduced a maintainer filename exactly; most are existing
files (`marked-spec.js`, `marked.json`, `core.plugin.tests.js`) where adding a case is obvious, but
the invented-name matches (`whiltespace_lines`, `adjacent_lists`, `html_comments`) are not.

Consequence for the paper: the entire aggregate A>B difference lives in `markedjs/marked`
(2018–2022, public, JS), which we can now show is contaminated for at least one instance — and that
instance is one of the three discordant wins. **NewtypeBench / `IBM/mcp-context-forge` (held out,
post-2026-01) is the pool to scale**, and the `marked` result should be reported with this caveat
attached, not as evidence of an effect.

### HAR product ideas from the test-quality analysis (ranked)
1. **Red-green guard stage** (deterministic, no LLM): stash the non-test part of the diff, run the
   agent's new tests, require failure; restore, require pass. Catches "changed behaviour, wrote no
   test" (`marked-1889` raw) and "my test passes at baseline too". One agent did this by hand on
   `mcp-3325` and it was the best-behaved session of the campaign. Fits `stages.json` as a
   `test-guard` stage, no new concepts.
2. **Differential/fuzz stage** for parser- and formatter-shaped repos: generate inputs along the
   dimensions the diff touches (escapes, whitespace, nesting, delimiters), run old vs new, surface
   behaviour deltas. Exactly the axis both arms under-sampled on `2483` and `1889`.
3. **Visual-diff stage** for pixel oracles: render every affected fixture before/after and surface
   the image diff. Would have made `Chart.js-7951`'s collateral rendering change visible.
4. **LLM test critic** (behind a flag): reads the diff, names untested input shapes. Highest ceiling,
   adds cost and nondeterminism to verification.

## 2026-09-25/26 — Held-out scale-up campaign (paused at 10/62)

Started 17:35Z, paused 23:17Z on operator request. Target: the 62 remaining
`IBM/mcp-context-forge` instances (all post-2026-01, held out), both arms, `--resume`.
Log `logs/heldout-mcp-20260925-1935.log`. **Resume with the exact same command** — 10 pairs are
recorded and will be skipped.

### Two infrastructure faults found in the first instance (both fixed)

1. **The scorer was dead and failing silently.** `prototypebench/backend-py312:latest` had been
   pruned from Docker since the pilot and is *not pullable* (`pull access denied` — the upstream
   project renamed to newtype-2038/newtypebench). Scoring failed `prestart failed (rc=125)` and
   the instance was recorded `resolved: false`. **Left unnoticed this produces a campaign of
   invalid zeros indistinguishable from real data.** Rebuilt both images locally from
   `.vendor/prototypebench/harness/docker/Dockerfile.backend` (`--build-arg PYTHON_VERSION=3.12`
   and `3.10`). Verified end to end: `3463` later scored `resolved: true`, and graded runs execute
   900–1200 P2P tests.
2. **HAR slot 1 is global per machine, and an agent will clear it destructively.** ARM A's launch
   gate failed with `[foreign_pm2] Foreign PM2 processes match agent 1: har-managersky-agent-1-*,
   har-tempo-agent-1-web`. On `3442` that burned both drift rounds and **ARM A never ran a solve**
   (pair invalid, not a loss). On `3441` the drift agent followed HAR's own advice — *"Stop the
   other harness session"* — and ran `npx pm2 delete` on all four, **stopping two unrelated
   projects' slot 1**. Product finding: the guard's wording invites a cross-repo teardown.

### Results: 10 pairs (`3442` ARM A invalid; `3339` interrupted mid-score, re-scored from patches)

| | A (HAR) | B (raw) |
|---|---|---|
| resolved | 2/10 | 2/10 |
| discordant pairs | **0** | |
| solve cost | $43.99 ($4.40 mean, 51 turns mean) | $46.53 ($4.23 mean, 55 turns mean) |
| launched a slot + ran `har env verify` | **10/10** | 0/10 |
| ran tests of its own devising | — | 9/11 |
| started services | 0/10 | 0/11 |

Drift: 3 sessions, **$1.35 total**; 9 of 10 gates green straight from cache. Total spend $91.87
for 10 pairs (~$9.19/pair → ~$570 for the full 62).

### The finding that matters: the held-out pool shows *zero* effect

Pooling with the pilot's held-out instances (mcp-context-forge + fastapi template):

**A 6/19, B 6/19, zero discordant pairs.** Against the contaminated `marked` pool's 11/14 vs 8/14
(3 discordant, all A). The contamination reading from 2026-09-11 is now much stronger: the entire
measured A>B difference lives in the pool with direct memorisation evidence, and vanishes on
held-out instances at n=19.

**Why the arms tie — evidence, not speculation.** On 7 of the 8 unresolved pairs both arms produce
*byte-identical grading profiles* (same F2P passed, same F2P not-passed, same P2P regressed):

| instance | F2P passed (A/B) | F2P failed (A/B) | P2P regressed (A/B) |
|---|---|---|---|
| 3396 | 6/6 | 1/1 | 0/0 |
| 3437 | 2/2 | 1/1 | 1/1 |
| 3453 | 3/3 | 1/1 | 0/0 |
| 3471 | 4/4 | 2/2 | 0/0 |
| 3510 | 3/3 | 2/2 | 0/0 |
| 3441 | 20/16 | 2/6 | 4/4 |
| 3414 | 12/13 | 10/9 | 1/1 |

Two arms with different patches, different turn counts and different verification regimes fail
*the same graded assertions*. Checked directly (`3471`): the not-passed tests are genuine assertion
failures (`assert '"uri":"file:///tmp"' in result` — compact JSON separators; `TypeError: Object of
type CustomObject is not JSON serializable`), i.e. **unstated acceptance criteria the agent cannot
discover locally**. This is the boundary of what a harness can buy: verification raises the floor
(it builds, it runs, nothing obviously broken) and cannot raise the ceiling (guessing a hidden
spec). Both arms hit the same ceiling.

**Both arms "regress" the same P2P tests** (`3441` 4/4, `3414` 1/1, `3437` 1/1) despite ARM A
verifying green *after* its last edit (checked in the transcripts: last verify at event 573 vs last
edit 497 on `3441`). Identical regressions across different patches point at the scorer environment
rather than either agent.

### Change before resuming: a no-op control

Score an **empty patch** on every instance first (no model spend, ~4 min each). It establishes which
F2P are reachable and which P2P are already red in the scorer environment, filters instances no arm
can win, and removes the regression artifact above. At $9.19/pair the current design spends ~50% of
its budget on instances that cannot discriminate.
