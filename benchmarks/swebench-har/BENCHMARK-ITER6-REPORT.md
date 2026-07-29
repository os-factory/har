# SWE-bench HAR — Iteration 6 Interim Report

**Batch:** `20260727-104245`  
**Host:** EC2 `sshbench` (`ec2-3-250-195-78`)  
**Sample:** SWE-bench Lite, seed `42`, n=`50`, diversity caps `max_per_repo=5` / `max_repos_per_language=10` (same draw as Iter 4–5)  
**Models:** fix=`gpt-5-mini`, setup=`gpt-5.5`  
**Scope of this report:** **43/50** instances completed at analysis time (2026-07-29); batch still running (~`[44/50]`). Official Docker eval **not** started yet — no resolve rates for Iter 6.  
**Hypothesis under test:** Soft oracle gate (launch+smoke required; fail-before preferred but not blocking) + stronger always-on Claude/Cursor DoD restores patch throughput lost in Iter 5’s hard gate, while keeping end-of-run fail-closed validity.

---

## 1. Executive verdict

Soft gate **worked for throughput**. Hard gate in Iter 5 starved the fixer (**10/50** HAR patches). Iter 6 has produced a nonempty HAR patch on **42/43** completed instances (**~98%**), with only **1** hard fail (`django-10924` soft-gate relaunch).

Soft gate **did not yet deliver honest verification**. Only **2/43** runs are `har_valid` (`matplotlib-23987`, `pytest-5413`). The dominant “warning” story is **not** “model couldn’t fix the bug.” Among the **20** runs that *did* establish a real fail-before oracle, post-fix `--full` failed with **`Permission denied` on the task stage script in 15/20** — i.e. the oracle that failed-before often **could not be re-executed** after the fix. That is a harness/overlay bug, and it poisons the Iter 6 validity signal.

| Signal | Iter 5 (hard gate, finished) | Iter 6 (soft gate, n=43/50) |
|--------|------------------------------|-----------------------------|
| HAR nonempty patches | **10/50** | **42/43** (~98% of completed) |
| HAR `failed` (no patch path) | **39/50** | **1/43** |
| HAR `completed` / `har_valid` | 3 completed; resolve **6/10** gated | **2** `har_valid` |
| Dominant mode | Never reach fixer (`missing_task_stage`) | Reach fixer, then `completed_with_warnings` |
| Official resolve | raw 22/49, HAR 6/10 | **TBD** (eval pending) |

**Paper-ready line:** Softening the pre-fix oracle gate restores agent throughput; measuring verification quality now requires fixing stage executability (and verify timeouts) before interpreting `post_fix_verify_failed` as model failure.

---

## 2. What Iter 6 changed

### Product
- Stronger always-on DoD: full root `CLAUDE.md.template` + aligned Cursor `har-workflow.mdc`
- If root `CLAUDE.md` already exists: idempotent marked section upsert (`<!-- har-workflow:start/end -->`)

### Benchmark runner
- Soft gate: launch + smoke required to reach fix
- Fail-before / task-stage strongly preferred during readiness; on miss → `har_oracle_deferred`, relaunch, fix still runs with deferred context
- End-of-run still fail-closed: `missing_task_stage`, `fail_before_not_established`, `post_fix_verify_failed`

### Ops note
- Batch stalled ~1.5 days on `psf__requests-2148` (HTTPServer `shutdown()` deadlock in a custom check). Unblocked 2026-07-29 by patching overlay checks + killing only the hung Python; **same** batch continued (no full restart).

---

## 3. Orchestration scoreboard (n=43 completed)

### Arm statuses
| HAR status | n | Meaning |
|------------|--:|---------|
| `completed` | 2 | `har_valid` — fail-before established + post-fix `--full` pass |
| `completed_with_warnings` | 40 | Patch usually present; validity flags failed |
| `failed` | 1 | Never reached a usable fix path |

**Raw:** 43/43 `completed` among finished instances.

### Invalid-reason frequencies (non-exclusive)
| Reason | n | Notes |
|--------|--:|-------|
| `post_fix_verify_failed` | 34 | Largest flag |
| `fail_before_not_established` | 20 | Mostly deferred soft-gate path |
| `missing_task_stage` | 15 | No issue-specific stage at end |
| `launch_or_smoke_gate_failed` | 1 | Soft-gate relaunch miss |

### Fail-before assessment
| `har_fail_before.reason` | n |
|--------------------------|--:|
| `task_stage_failed_as_expected` | 22 |
| *(missing / never assessed)* | 12 |
| `task_stages_not_executed` | 6 |
| `env_blocks_oracle` | 3 |

### Soft-gate usage
| `har_oracle_deferred` | n |
|-----------------------|--:|
| `false` (oracle ready before fix) | 22 |
| `true` (deferred) | 21 |

Roughly **half** of runs still fail to establish fail-before during readiness — but unlike Iter 5, the fixer still runs.

### Verify outcomes
| Metric | n |
|--------|--:|
| `har_ready_for_fix` | 42 |
| `har_verify_attempted` | 42 |
| `har_verify_passed` | 8 |
| nonempty `har.jsonl` patch | 42 |

Note: `har_verify_passed` (8) ≫ `har_valid` (2) because smoke-only / baseline `--full` can pass without a task-stage oracle.

---

## 4. Mutually exclusive failure taxonomy

Applied in order on the 43 completed runs:

| Bucket | n | Share | Interpretation |
|--------|--:|------:|----------------|
| **1. Oracle OK + post_fix PASS → `har_valid`** | 2 | 4.7% | Intended happy path |
| **2. Oracle OK + post_fix FAIL** | 20 | 46.5% | Best “model quality” candidates — **but see §5** |
| **3. Deferred + no task stage at end** | 15 | 34.9% | Soft gate open; agent never created oracle |
| **4. Deferred + task stage id appeared** | 5 | 11.6% | Stage registered but fail-before never executed it |
| **7. Soft-gate relaunch / launch failure** | 1 | 2.3% | Infrastructure |
| 5–6 / other (exclusive) | 0 | — | Appear only as tags on deferred |

### Bucket 1 — successes
| Instance | Task stage |
|----------|------------|
| `matplotlib__matplotlib-23987` | `constrained-layout-warning` |
| `pytest-dev__pytest-5413` | `raises-str-behavior` |

Both: fail-before `task_stage_failed_as_expected`, then post-fix all stages green.

### Bucket 7 — hard fail
- `django__django-10924` — `HAR soft-gate relaunch failed (launch or smoke) before fix stage`  
  Prior fail-before attempt: `task_stages_not_executed`. No HAR patch.

---

## 5. Deep dive: why “oracle OK + post_fix FAIL” is mostly a HAR bug

Among **all 20** bucket-2 instances, last verify logs show:

| Primary post_fix signal | n / 20 |
|---------------------------|------:|
| **`Permission denied` on task stage `.sh` / check script** | **15** |
| `ModuleNotFoundError` (e.g. `distutils` on sympy) | 3 |
| Other (missing overlay path / ImportError) | 2 |
| Clean residual `AssertionError` on the product bug | **0** |

### What this means
Fail-before **did** run the behavioral check and record a non-env failure (`env_failure: false`). After the fix agent ran, the **same stage file often lost execute permission** (or path/overlay broke), so `--full` failed in ~30ms with `Permission denied` — not with “assertion still fails.”

**Impact on Iter 6 interpretation:**  
`post_fix_verify_failed` **cannot** be read as “fix didn’t work” until chmod/path integrity is fixed. The 20/43 bucket is currently a **harness regression detector**, not a model-quality meter.

### Likely mechanism (to confirm in code)
Task stages live under `.har/stages/` and/or task-overlay copies. Between fail-before verify and post-fix verify, something in worktree restore / overlay restore / `save_har_cache` strip / git checkout drops the executable bit on generated scripts. Custom `check_*.py` invoked via a non-executable wrapper `.sh` shows the same symptom.

### Representative examples
| Instance | Task stage | Post_fix |
|----------|------------|------------|
| `matplotlib-25498` | `colorbar-norm-update` | `.sh: Permission denied` |
| `pytest-11143` | `rewrite-number-literal` | `.sh: Permission denied` |
| `requests-1963` | `redirect-method-regression` | `.sh: Permission denied` |
| `sympy-20049` | `point-vel-behavior` | `No module named 'distutils'` |
| `matplotlib-22835` | `cursor-boundarynorm` | overlay `.sh: No such file` |

---

## 6. Deep dive: deferred oracles (buckets 3–4)

### No task stage (15)
- **15/15** still produced a nonempty patch (soft gate doing its job).
- **5/15** even got `har_verify_passed=true` on baseline/smoke stages only — exactly the “smoke ≠ done” failure mode Iter 2–4 warned about; correctly marked invalid via `missing_task_stage` + `fail_before_not_established`.
- Secondary tags: 3× `env_blocks_oracle` during readiness (import/deps blocked a would-be oracle).

### Stage appeared but never fail-before-executed (5)
Examples: `version-info`, `separability-nested`, `skipif-string-cache`, `index-symbols`, `numref-table-warning`.  
All carried `fb.reason=task_stages_not_executed`. One (`matplotlib-18869`) passed post_fix verify but remained invalid (no proven fail-before).

**Product reading:** Always-on DoD + readiness prompts still leave ~half of runs without a proven oracle. Soft gate correctly refuses to starve the fixer; it does **not** by itself create oracles.

---

## 7. Ops incident: `psf__requests-2148`

- Wall clock ~**36h** for one instance; batch single-threaded → whole campaign stalled.
- Fail-before on `socket-error-wrap` succeeded earlier; hang was in stage `iter-content-decode-unicode`: custom HTTP check printed FAIL then deadlocked on `HTTPServer.shutdown()` while a `stream=True` client held the connection.
- Root runner gap: `har_verify()` in `scripts/lib/har_utils.py` calls `run_command(...)` **with no timeout** — setup/solve budgets do not cover verify.
- Unblock (2026-07-29): patch overlay checks to `server_close()` + `os._exit`, kill hung Python only, keep `run_batch` / batch id. Instance finished `completed_with_warnings`; later verifies showed `Permission denied` (bucket-2 pattern).

---

## 8. Comparison to prior iterations (orchestration)

| Iter | Gate | HAR patches | HAR validity / resolve | Lesson |
|------|------|-------------|------------------------|--------|
| 4 | Soft guidance, no fail-before hard gate | 50/50 | resolve 24/50; `--full` weak vs gold | Throughput OK; oracle quality weak |
| 5 | **Hard** fail-before before fix | **10/50** | resolve **6/10** gated / 6/50 overall | Gate filters well when oracle exists; usually never created |
| 6 | **Soft** fail-before + end fail-closed | **42/43** (partial) | `har_valid` **2/43**; resolve TBD | Throughput restored; validity wrecked by chmod/env + still ~50% deferred |

---

## 9. What to improve in HAR (priority order)

### P0 — Product / runner bugs that invalidate the benchmark
1. **Preserve executable bit on stage scripts** across worktree launch, task-overlay snapshot/restore, and cache strip. Add a verify preflight: `chmod +x` every stage script listed in `stages.json` / verificationStages before running. Add a unit/integration test that fail-before → edit → post_fix can re-run the same `.sh`.
2. **Timeout `har_verify` / `verify.sh`** (and per-stage wall clocks). A single hung custom check must not block a multi-day batch. Default e.g. 15–30 minutes for `--full` in the benchmark runner; surface `verify_timeout` as an invalid reason.
3. **Sandbox guidance for custom checks:** prefer `os._exit` / avoid `HTTPServer.shutdown()` with open streaming clients; document in `STAGES.md` / add-stage cookbook.

### P1 — Make deferred oracles rarer (real product goal)
4. **Stronger readiness loop** when soft-deferred: fix prompt already gets deferred context; consider one mandatory “create oracle first” mini-turn even under soft gate, or refuse `har_verify_passed` credit unless a task stage exists.
5. **Env-blocked oracles:** treat `env_blocks_oracle` as a bootstrap/install failure and spend setup budget on install before accepting deferral (especially sklearn/astropy/sympy).
6. Keep always-on `CLAUDE.md` / Cursor rule / marked-section upsert — necessary but **not sufficient** alone (21/43 still deferred).

### P2 — Measurement honesty
7. Split metrics in reports:
   - **Throughput:** nonempty patch rate, reach-fix rate  
   - **Oracle quality:** fail-before established rate  
   - **Verify integrity:** post_fix executable / non-env fail rate  
   - **Validity:** `har_valid` only when integrity holds  
8. Do not equate `post_fix_verify_failed` with “bad fix” until P0#1 is fixed; re-score Iter 6 after a chmod hotfix if feasible (replay verify on frozen worktrees).

### P3 — Campaign tooling
9. Resume / skip-completed for `run_batch.py` (today: kill batch ⇒ new batch_id and redo 1..N).
10. Heartbeat / stuck-stage detector in `ec2_run.sh` (alert if one verify exceeds budget).

---

## 10. Recommended next experiments

1. **Hotfix P0#1–2** on the runner + stage execution path; optionally re-verify completed Iter 6 worktrees offline to estimate how many of the 20 bucket-2 runs would flip to pass/fail-on-assertion.
2. Finish this batch + official eval → compare resolve vs Iter 4/5 (throughput hypothesis).
3. **Iter 7:** soft gate + chmod preflight + verify timeout + slightly stricter “no task stage ⇒ one forced readiness retry” — expect higher `har_valid` without returning to Iter 5 starvation.

---

## 11. Caveats

- Report is **interim** (43/50). Final tables may shift slightly; eval resolve is unknown.
- Analysis uses orchestration `run.json` + verify artifacts, not SWE-bench gold tests.
- Permission-denied diagnosis is from verify stdout; root cause in HAR copy/chmod path should be confirmed with a minimal repro in-repo.

---

## Appendix — quick reference counts (n=43)

```
har_status:           completed=2  warnings=40  failed=1
har_valid:            2/43
patches nonempty:     42/43
oracle_deferred:      21/43
fail_before OK:       22/43
post_fix_verify_failed: 34
missing_task_stage:   15
Permission denied among oracle-OK post_fix fails: 15/20
hang outlier:         requests-2148 ~36h (unblocked in-place)
```

**Artifacts:** EC2 `/tmp/iter6-analysis.json`, `/tmp/iter6-taxonomy.md`; batch `~/har/benchmarks/swebench-har/batches/20260727-104245/`; runs under `~/har/benchmarks/swebench-har/runs/20260727-*` and later.
