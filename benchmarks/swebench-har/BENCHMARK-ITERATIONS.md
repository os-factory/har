# SWE-bench HAR — Iteration Log (paper track)

Living log of benchmark/HAR iterations for the scientific write-up.
Each iteration records **hypothesis → change → measured outcome**.

Dataset unless noted: **SWE-bench Lite** `test` (300 instances).  
Models: fix=`gpt-5-mini`, HAR setup=`gpt-5.5`. Arms: **raw** vs **HAR**.

---

## Iteration 0 — Baseline orchestration (2026-07-08)

**Batch:** `20260708-173731` · seed `42` · n=`10`  
**Hypothesis:** HAR-assisted Codex can produce patches on SWE-bench instances.  
**Setup:** Pre-fix launch+verify gate; no official Docker eval.

| Arm | Patches | Official resolve |
|-----|---------|------------------|
| Raw | 10/10 | not run |
| HAR | **5/10** | not run |

**Finding:** HAR failures were **infrastructure** (gate never passed); fix agent often never ran.  
**Doc:** `BENCHMARK-RUN-REPORT.md`

---

## Iteration 1 — Make HAR finish (2026-07-18)

**Batch:** `20260718-185954` · seed `42` · n=`10`  
**Hypothesis:** Fixing init/CLI/gate/smoke contracts unblocks the HAR arm.  
**Changes:**
- HAR CLI invocation via Node; non-interactive `har env init`
- Setup retries / smoke-level pre-fix gate (not full suite)
- Per-repo `.har-cache`
- First official SWE-bench Docker evaluation on this sample

| Arm | Patches | Resolve |
|-----|---------|---------|
| Raw | 10/10 | **4/10** |
| HAR | **10/10** | **5/10** |

**Finding:** Orchestration gap closed (5→10 HAR patches). HAR uniquely resolved `matplotlib-25498`.  
Post-fix verify was mostly **smoke** (compile/import).

---

## Iteration 2 — Functional verification prompts (2026-07-18/19)

**Batch:** `20260718-230801` · seed `42` · n=`10`  
**Hypothesis:** If prompts state that HAR is a **verification sandbox** and agents **may add stages/tests on the fly**, resolve rises.  
**Changes (product + benchmark):**
- Prompts: done = `verify --full`; allow `har env add-stage` + small regression tests
- Boilerplate `CLAUDE.agent.md` / setup-har skill / adaptation prompt
- Config: `har_verify_full: true`
- Commit `b817956`

| Arm | Patches | Resolve | HAR `--full` pass |
|-----|---------|---------|-------------------|
| Raw | 10/10 | **6/10** | — |
| HAR | 10/10 | **5/10** | **2/10** |

**Finding:** Agents *did* add issue-specific stages (`password-reset-token`, `colorbar-update-norm`, …).  
Resolve did **not** improve for HAR. New failure modes:
1. **Cache pollution** — issue stages persisted into `.har-cache` and poisoned later Django `--full` runs  
2. **Not fail-closed** — patches submitted despite failed `--full`  
3. **False greens** — agent stages ≠ official FAIL_TO_PASS (e.g. matplotlib-25498)

**Paper lesson (locked in):** prompts must explicitly say stages/tests can be added on the fly; HAR’s purpose is verifying code changes in a sandbox — but runner semantics must match.

---

## Iteration 3 — Task-scoped stages + fail-closed retries (2026-07-20)

**Batch:** `20260720-195658` · seed `42` · n=`10`  
**Hypothesis:** Isolating task stages from cache + fail-closed `--full` with fix retries improves harness honesty and possibly resolve.  
**Changes:**
- Task stages snapshotted to per-run overlay; `.har-cache` keeps only baseline stage IDs
- Post-fix `--full` failure → `post_fix_verify_failed` + up to `fix_max_rounds: 3`
- Prompt wording: sandbox + fail-before/pass-after + do not pollute cache
- Commit `a63b10b`

| Arm | Patches | Resolve | HAR `--full` pass | `post_fix_verify_failed` |
|-----|---------|---------|-------------------|---------------------------|
| Raw | 10/10 | **4/10** | — | — |
| HAR | 10/10 | **4/10** | **5/10** | **5/10** |

**Per-instance resolve:** both arms resolved the same four: django-11099, matplotlib-25498, sympy-20442, django-12915.  
**Finding:** Fail-closed instrumentation works (5 failures recorded). Stage lists no longer show cross-issue Django pollution in the same way as Iter 2. Resolve tied with raw at 4/10 on this draw (model variance vs Iter 1–2).  
**Still open:** agent functional stages can disagree with gold tests; n=10 too small for uplift claims.

---

## Iteration 4 — Diversified n=50 (complete)

**Batch:** `20260723-113828` · seed `42` · n=`50`  
**Host:** EC2 `sshbench` · orch ~10h · eval completed 2026-07-24  
**Hypothesis:** With Iter 3 harness semantics, a larger **repo-diverse** sample yields a stable raw-vs-HAR comparison.  
**Sampling:** `max_per_repo=5`, `max_repos_per_language=10` → 10 Python repos × 5.

| Arm | Patches | Resolve | Notes |
|-----|---------|---------|-------|
| Raw | 50/50 | **23/50 (46%)** | 2 unique wins |
| HAR | 50/50 | **24/50 (48%)** | 3 unique wins; net **+1** |

**HAR verify:** `--full` pass 22/50; `post_fix_verify_failed` 28/50. `--full` vs official resolve: TP10 / FP12 / FN14 / TN14 (weak predictor).

**Full write-up:** `BENCHMARK-50-REPORT.md`

---

## Iteration 5 — Fail-before + behavioral oracles (in progress)

**Batch:** _TBD_ · seed `42` · n=`50` (same diversity caps)  
**Hypothesis:** Stronger product prompts + runner **fail-before / task-stage** gates make stages real oracles (from the problem statement only), improving independent verification quality and possibly resolve.

**Product changes:**
- `CLAUDE.agent.md` / `STAGES.md` / setup-har / adaptation: smoke ≠ done; require change-specific stage; fail-before/pass-after; runnable oracles

**Benchmark changes:**
- Readiness must register a task stage that **fails on the buggy tree** (not env ImportError)
- Fix prompts require fail-before then pass-after without gold tests

| Arm | Patches | Resolve | Notes |
|-----|---------|---------|-------|
| Raw | _TBD_ | _TBD_ | |
| HAR | _TBD_ | _TBD_ | |

---

## Cumulative HAR product changes (for paper “methods”)

1. **Pre-fix gate = launch + smoke**, not full suite.  
2. **Definition of done = `verify --full`**, with agents allowed to **add verification stages and small tests on the fly**.  
3. **Task-scoped stages** must not enter the reusable per-repo harness cache.  
4. **Fail-closed post-fix verify** with bounded fix retries.  
5. **Repeatable EC2 campaign tooling** (`EC2.md`, bootstrap/run/evaluate scripts).

Branch: `feat/functional-verify-agent-guidance` (`b817956`, `a63b10b`, + Iter 4 sampling).

---

## Scoreboard snapshot (seed 42, n=10 fixed sample)

| Iter | Batch | Raw resolve | HAR resolve | HAR patches |
|------|-------|-------------|-------------|-------------|
| 0 | `20260708-173731` | — | — | 5/10 |
| 1 | `20260718-185954` | 4/10 | 5/10 | 10/10 |
| 2 | `20260718-230801` | 6/10 | 5/10 | 10/10 |
| 3 | `20260720-195658` | 4/10 | 4/10 | 10/10 |
| 4 | `20260723-113828` (n=50) | **23/50** | **24/50** | 50/50 |
