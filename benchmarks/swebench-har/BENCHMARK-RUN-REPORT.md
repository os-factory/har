# SWE-bench HAR Benchmark — Run Report

**Batch ID:** `20260708-173731`  
**Date:** 2026-07-08  
**Dataset:** SWE-bench Lite (`test` split)  
**Sample seed:** `42`  
**Instances:** 10  
**Arms:** raw + HAR (both per instance)  
**Fix model:** `gpt-5-mini`  
**HAR setup model:** `gpt-5.5`  
**Duration:** ~63 minutes (17:37 → 18:40 UTC)

Official SWE-bench Docker evaluation was **not** run on this batch. Metrics below describe **orchestration outcomes** (did Codex finish? was a patch produced?), not whether patches resolve the underlying bugs.

---

## Executive summary

| Arm | Orchestration completed | Patch produced |
|-----|-------------------------|----------------|
| **Raw** | 10 / 10 | 10 / 10 |
| **HAR** | 5 / 10 | 5 / 10 |

The raw arm is reliable end-to-end. The HAR arm fails **before the fix stage** in half of cases: the runner-enforced **launch + verify gate** does not pass after GPT-5.5 harness setup (max 2 attempts per instance).

HAR succeeds more often on **later instances of the same repository**, once a per-repo `.har/` cache exists. That suggests the approach is viable but needs **stronger, language-agnostic launch/verify contracts** and **better retry/cache policy** — not just prompt tuning.

SWE-bench Lite spans **Python, JavaScript, and other stacks**. This run sampled mostly Python repos (Django, matplotlib, SymPy, Sphinx), but findings are framed for **any language** unless noted otherwise.

---

## Sampled instances

| # | Instance | Repository |
|---|----------|------------|
| 1 | `django__django-13551` | django/django |
| 2 | `django__django-11099` | django/django |
| 3 | `matplotlib__matplotlib-25498` | matplotlib/matplotlib |
| 4 | `matplotlib__matplotlib-23476` | matplotlib/matplotlib |
| 5 | `django__django-16816` | django/django |
| 6 | `django__django-14382` | django/django |
| 7 | `django__django-13315` | django/django |
| 8 | `sympy__sympy-20442` | sympy/sympy |
| 9 | `django__django-12915` | django/django |
| 10 | `sphinx-doc__sphinx-8474` | sphinx-doc/sphinx |

---

## Per-instance results

| # | Instance | Raw | HAR | HAR cache hit | HAR setup (s) |
|---|----------|-----|-----|---------------|---------------|
| 1 | django-13551 | ✅ patch | ❌ gate | — | 445 |
| 2 | django-11099 | ✅ patch | ❌ gate | — | 258 |
| 3 | matplotlib-25498 | ✅ patch | ❌ gate | — | 397 |
| 4 | matplotlib-23476 | ✅ patch | ✅ patch | — (saved cache) | 271 |
| 5 | django-16816 | ✅ patch | ❌ gate | — | 321 |
| 6 | django-14382 | ✅ patch | ✅ patch | — (saved cache) | 266 |
| 7 | django-13315 | ✅ patch | ✅ patch | yes | 128 |
| 8 | sympy-20442 | ✅ patch | ✅ patch | yes | 0 |
| 9 | django-12915 | ✅ patch | ✅ patch | yes | 0 |
| 10 | sphinx-8474 | ✅ patch | ❌ gate | — | 313 |

**HAR failure mode (all 5):** `HAR launch/verify gate failed before fix stage` — Codex fix never ran.

---

## Findings

### 1. Raw Codex arm is a stable baseline

All 10 instances completed in ~1–2 minutes each with a non-empty `model_patch`. No infrastructure dependency beyond git checkout + Codex SDK.

### 2. HAR failures are infrastructure, not fix-model failures

Failed HAR runs never reached the fix agent. Root causes cluster into **language-agnostic categories**:

| Category | Example from this run | Language-agnostic pattern |
|----------|----------------------|---------------------------|
| **Launch env not provisioned** | django-16816: interpreter/toolchain not found during launch | Launch must install/select toolchain (runtime, package manager, deps) and record paths in `.env.agent.<id>` |
| **Verify uses wrong paths** | django-13551: verify referenced a venv binary launch never created | Verify must consume launch outputs, not hardcoded paths |
| **Toolchain / version mismatch** | django-11099: missing stdlib/module for that commit’s era | Harness must detect project requirements (version files, CI, build manifests) |
| **Verify too heavy for pre-fix gate** | matplotlib-25498: full test runner/conftest failed before any fix | Pre-fix gate should be smoke-level (build/compile/import), not full suite |
| **Domain import graph too early** | sphinx-8474: extension loading failed during verify | Smoke verify should not require full application/plugin graph |

These patterns apply equally to **Node, Go, Rust, Java**, etc.: launch provisions the toolchain; verify quick mode checks “can I build/load the project?” not “do all tests pass?”.

### 3. Per-repo `.har/` cache helps but is fragile

- Cached repos after this run: `django-django`, `matplotlib-matplotlib`, `sympy-sympy`
- **Not cached:** `sphinx-doc/sphinx` (gate never passed)
- First instance on a repo often pays **4–7 min** setup; cache hits dropped setup to **0 s** (SymPy, later Django)
- Early failures on django-13551/11099 happened **before** a good cache existed; later django instances succeeded
- **No cache invalidation** on gate failure — stale/bad harness can persist

### 4. Setup retry budget is too small

`setup_max_attempts: 2` then the instance is abandoned. Several repos might succeed on attempt 3+ or after cache refresh.

### 5. GPT-5.5 setup agent scope is too broad

Setup edits `launch.sh`, `harness.env`, and `verify.sh` with repo-specific shell. That duplicates logic HAR templates should own and breaks cross-commit reuse. **Launch contract should be template-owned; setup should configure verify stages and env knobs only.**

### 6. HAR `cli` profile is not language-complete out of the box

Stock `har-boilerplate-cli/launch.sh` handles **npm/go** paths explicitly; other ecosystems rely on agent improvisation. For SWE-bench (polyglot), HAR needs **extensible launch hooks** per ecosystem (Python, Node, Java, Rust, …) — not Python-only special cases in a one-off benchmark.

### 7. Pre-fix vs post-fix verify are conflated

The gate requires full `har env verify 1` to pass **before** the bug fix. For SWE-bench, grading uses the **official evaluator**; harness verify should only prove **the agent can work in the slot** (launch + minimal smoke).

---

## Recommended GitHub issues

Use these as separate trackable items before re-running the 10-instance batch.

### Issue A — Benchmark: retry until gate passes (budget-based)

- Replace fixed `setup_max_attempts: 2` with a **time/token budget**
- Do not mark instance failed until budget exhausted
- Invalidate `.har-cache` on gate failure after cache hit
- Feed **structured gate JSON** (launch ok, verify stages, stderr) into setup retries

**Repo:** `benchmarks/swebench-har`

### Issue B — Benchmark: split pre-fix gate vs post-fix verify

- **Pre-fix gate:** launch OK + workdir + `.env.agent.<id>` + smoke (compile/import/build)
- **Post-fix:** existing `har env verify` (can run stricter checks)
- Document gate criteria in README

**Repo:** `benchmarks/swebench-har`

### Issue C — HAR template: language-agnostic launch provisioning

- Extend `cli` profile launch to provision toolchain via **declarative config** in `harness.env` (e.g. ecosystem key + install command), not hardcoded Python-only logic
- Write resolved tool paths (`PYTHON_BIN`, `NODE_BIN`, `CARGO_TARGET`, …) into `.env.agent.<id>`
- Verify scripts **must** read from agent env, never guess paths

**Repo:** `src/templates/har-boilerplate-cli/`

### Issue D — HAR template: tiered verify (`--quick` vs `--full`)

- Quick: smoke steps only (syntax/compile/import/build)
- Full: unit tests, lint, typecheck
- Benchmark gate and `har env verify` default to quick unless `--full`

**Repo:** `src/templates/har-boilerplate-cli/verify.sh` (+ default/ios profiles)

### Issue E — Benchmark: narrow GPT-5.5 setup prompt scope

- Forbid editing `launch.sh` / `agent-slot.sh`
- Only adapt `harness.env` + verify stage configuration
- Explicit: SWE-bench grading is external; harness verify is smoke-only
- Language-agnostic wording (build manifest, test runner, CI configs — not “pytest only”)

**Repo:** `benchmarks/swebench-har/prompts/har-setup.md`

### Issue F — Benchmark: batch evaluation wrapper

- Aggregate `predictions/*.jsonl` across a batch into one SWE-bench eval invocation
- Produce comparison table: raw vs HAR resolve rate

**Repo:** `benchmarks/swebench-har/scripts/`

### Issue G — HAR: `har env doctor` preflight

- Check git, worktree, toolchain on PATH, required env vars — without Codex
- Callable from benchmark before setup agent runs

**Repo:** HAR CLI

---

## Re-run checklist (after merges)

1. Merge benchmark package + fixes from issues A, B, E, F
2. Merge HAR template changes from issues C, D (and G if ready)
3. Clear or version `.har-cache/` if launch/verify contract changed
4. Run:

```bash
cd benchmarks/swebench-har
uv run scripts/run_batch.py --count 10 --seed 42 --arm both
```

5. Run batch evaluation (issue F) against official SWE-bench Docker harness
6. Compare resolve rates raw vs HAR — orchestration success rate should reach **10/10 HAR** before resolve rate is meaningful

---

## Artifacts from this run

| Path | Description |
|------|-------------|
| `batches/20260708-173731/batch.json` | Batch orchestration summary |
| `runs/<run-id>/run.json` | Per-instance arm metrics |
| `runs/<run-id>/predictions/raw.jsonl` | Raw patches (10) |
| `runs/<run-id>/predictions/har.jsonl` | HAR patches (5) |
| `logs/batch-10-seed42.log` | Batch stdout log |
| `.har-cache/` | Adapted harness per repo (local, gitignored) |

---

## Conclusion

This run validates the **benchmark harness design** (paired arms, Codex SDK, per-repo cache, split setup/fix models, runner gates) but shows HAR is **not yet competitive with raw** on orchestration reliability (50% vs 100%). The gap is not the fix model — it is **launch/verify readiness** across polyglot SWE-bench repos.

Priority: **template-owned launch provisioning + smoke-only pre-fix gate + retry until success**, then re-run the same 10 instances with official evaluation.
