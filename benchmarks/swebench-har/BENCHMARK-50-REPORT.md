# SWE-bench HAR Benchmark Report — Diversified n=50

**Batch:** `20260723-113828`  
**Date:** 2026-07-23 → 2026-07-24  
**Dataset:** SWE-bench Lite (`test`)  
**Sample:** seed `42`, count `50`, max **5** instances/repo, max **10** repos/language  
**Arms:** raw Codex vs HAR-assisted Codex  
**Models:** fix=`gpt-5-mini`, HAR setup=`gpt-5.5`  
**HAR stack:** functional-verify prompts + task-scoped stages + fail-closed `--full` (`fix_max_rounds: 3`)  
**Host:** EC2 `sshbench`  
**Orchestration:** 11:38 → 21:41 UTC (~10h) · **Eval finished:** 2026-07-24 ~00:06 UTC

This is **Iteration 4** of the campaign (see `BENCHMARK-ITERATIONS.md`).

---

## Executive summary

| Metric | Raw | HAR |
|--------|-----|-----|
| Patches produced | **50/50** | **50/50** |
| Official resolve | **23/50 (46%)** | **24/50 (48%)** |
| Unique resolves | 2 | **3** |
| Both resolved | 21 | 21 |
| Neither | 24 | 24 |

HAR edges raw by **+1 resolve** on this diversified 50. Orchestration is solid (no failed instances). Post-fix `verify --full` remains a **weak proxy** for official SWE-bench resolve (many false greens and false reds).

---

## Sampling (diversity)

SWE-bench Lite has 12 repos (all Python). Caps selected the 10 largest repos × 5 instances:

| Repository | n | Raw resolve | HAR resolve | HAR `--full` pass |
|------------|---|-------------|-------------|-------------------|
| astropy/astropy | 5 | 2 | 2 | 0 |
| django/django | 5 | 1 | 1 | 4 |
| matplotlib/matplotlib | 5 | 3 | 2 | 4 |
| psf/requests | 5 | 3 | **4** | 3 |
| pydata/xarray | 5 | 1 | 1 | 2 |
| pylint-dev/pylint | 5 | 1 | **2** | 4 |
| pytest-dev/pytest | 5 | 3 | 3 | 3 |
| scikit-learn/scikit-learn | 5 | **5** | 4 | 0 |
| sphinx-doc/sphinx | 5 | 3 | 3 | 1 |
| sympy/sympy | 5 | 1 | **2** | 1 |

Without the per-repo cap, seed-42 draws historically over-weighted Django/SymPy; this sample is intentionally broader.

---

## Resolve agreement (raw vs HAR)

| Outcome | Count | Instances |
|---------|-------|-----------|
| Both resolve | 21 | — |
| HAR only | **3** | `psf__requests-1963`, `pylint-dev__pylint-7993`, `sympy__sympy-15609` |
| Raw only | **2** | `matplotlib__matplotlib-23987`, `scikit-learn__scikit-learn-12471` |
| Neither | 24 | — |

Net unique advantage: **HAR +1**.

---

## HAR verification behavior

| Signal | Count |
|--------|-------|
| Pre-fix ready | 50/50 |
| Post-fix `--full` pass | **22/50** |
| `post_fix_verify_failed` (fail-closed warning) | **28/50** |
| Arm status `completed_with_warnings` | 28 |
| Arm status `completed` | 22 |

### Does `--full` predict official resolve?

| | Official resolved | Official unresolved |
|--|-------------------|---------------------|
| `--full` pass | TP **10** | FP **12** |
| `--full` fail | FN **14** | TN **14** |

`--full` is roughly coin-flip vs gold tests on this sample: many agent-written stages pass while SWE-bench fails (FP), and many patches resolve officially while `--full` still fails (FN — often polluted/noisy or over-strict stages). Fail-closed correctly *marks* failures but still submits patches for grading (warnings path).

Agents did add issue-specific stages (examples): `colorbar-norm`, `redirect-method-regression`, `pipeline-len`, `napoleon-trailing-underscore`, `p7080-ignore-paths`, `latex-indexed-matrix`, …

---

## Campaign context (same seed family)

| Iter | Batch | n | Raw resolve | HAR resolve | Notes |
|------|-------|---|-------------|-------------|-------|
| 0 | `20260708-173731` | 10 | — | — | HAR patches 5/10 (gate) |
| 1 | `20260718-185954` | 10 | 4/10 | 5/10 | Gate fixed |
| 2 | `20260718-230801` | 10 | 6/10 | 5/10 | Functional prompts; cache pollution |
| 3 | `20260720-195658` | 10 | 4/10 | 4/10 | Fail-closed + task-scoped stages |
| **4** | **`20260723-113828`** | **50** | **23/50** | **24/50** | Diversified sample |

Small-n swings (±1–2) are noise; the n=50 result is the first stable head-to-head under the improved HAR stack.

---

## What improved in HAR (methods relevant to this run)

1. **Sandbox framing** — agents may add stages/tests on the fly; done = `verify --full`.
2. **Task-scoped stages** — issue stages do not permanently pollute `.har-cache`.
3. **Fail-closed instrumentation** — failed `--full` recorded (`post_fix_verify_failed`) with fix retries.
4. **Diversity sampling** — fairer repo mix for paper claims.

---

## Limitations / next work

1. **Align stages with FAIL_TO_PASS** (or run a subset of official tests) to cut FP/FN vs gold.
2. **Decide patch policy** when `--full` fails: withhold patch vs warn-and-submit (today: warn-and-submit).
3. **Cost/latency** — ~10h orchestration + overnight Docker eval for n=50 × 2 arms.
4. **Language diversity** — Lite is Python-only; language cap matters more on full SWE-bench.
5. **Multiple seeds** — single seed 42; replicate before strong claims.

---

## Artifacts

- EC2 batch: `batches/20260723-113828/batch.json`
- Eval: `results/batch-20260723-113828/batch-evaluation.{json,md}`
- Comparison: `results/ec2-comparison.json`
- Iteration log: `BENCHMARK-ITERATIONS.md`
- PR: https://github.com/os-factory/har/pull/75

---

## Per-instance resolve table

| # | Instance | Raw | HAR |
|---|----------|-----|-----|
| 1 | matplotlib-25498 | yes | yes |
| 2 | xarray-3364 | no | no |
| 3 | xarray-5131 | yes | yes |
| 4 | sphinx-8627 | yes | yes |
| 5 | astropy-14182 | no | no |
| 6 | matplotlib-23987 | yes | no |
| 7 | matplotlib-23913 | yes | yes |
| 8 | sphinx-7738 | no | no |
| 9 | xarray-4094 | no | no |
| 10 | pytest-11143 | yes | yes |
| 11 | requests-1963 | no | **yes** |
| 12 | django-11797 | no | no |
| 13 | sklearn-13439 | yes | yes |
| 14 | matplotlib-18869 | no | no |
| 15 | pytest-11148 | no | no |
| 16 | django-10924 | yes | yes |
| 17 | pylint-7114 | no | no |
| 18 | requests-2674 | yes | yes |
| 19 | sklearn-14894 | yes | yes |
| 20 | sympy-14317 | no | no |
| 21 | pylint-7228 | no | no |
| 22 | requests-3362 | no | no |
| 23 | sklearn-13496 | yes | yes |
| 24 | pylint-7993 | no | **yes** |
| 25 | astropy-12907 | yes | yes |
| 26 | xarray-4493 | no | no |
| 27 | pytest-5227 | yes | yes |
| 28 | pytest-5413 | no | no |
| 29 | sympy-15609 | no | **yes** |
| 30 | sympy-20049 | no | no |
| 31 | sphinx-8713 | yes | yes |
| 32 | pytest-7373 | yes | yes |
| 33 | sphinx-7975 | yes | yes |
| 34 | requests-2148 | yes | yes |
| 35 | django-11964 | no | no |
| 36 | astropy-6938 | yes | yes |
| 37 | astropy-14365 | no | no |
| 38 | sympy-21171 | no | no |
| 39 | sphinx-8474 | no | no |
| 40 | matplotlib-22835 | no | no |
| 41 | requests-863 | yes | yes |
| 42 | astropy-7746 | no | no |
| 43 | django-16229 | no | no |
| 44 | sklearn-12471 | yes | no |
| 45 | sympy-18532 | yes | yes |
| 46 | xarray-4248 | no | no |
| 47 | django-12284 | no | no |
| 48 | sklearn-11281 | yes | yes |
| 49 | pylint-7080 | yes | yes |
| 50 | pylint-6506 | no | no |
