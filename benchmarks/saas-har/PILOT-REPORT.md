# Pilot report — SaaS/HAR paired benchmark (2026-09-10)

> **Protocol note.** Everything below §5 describes **protocol v1**, whose prompt told each arm how
> to verify and handed ARM A a launched slot. That design was replaced the same evening by
> **protocol v2** (one minimal, arm-identical prompt; nothing pre-launched; workflow behaviour
> measured instead of instructed) — see [PROTOCOL.md](./PROTOCOL.md) for the spec and the reasons.
> v1 results are kept for their findings and are never pooled with v2 numbers.

## 1. Question

Does a repository that was made *agent-ready* through HAR (`.har/` harness adapted **without knowledge of the task**, slot launched, `har env verify` available) change how often, how fast and how cheaply the **same** coding model solves real merged-PR tasks on web-SaaS / backend-API repositories?

- ARM A: Claude Code `claude-opus-4-8` in a HAR slot; harness adapted by `claude-sonnet-5`, task-blind, cached per repository and drift-checked at every later commit.
- ARM B: Claude Code `claude-opus-4-8` on a plain checkout at the same commit, same prompt, same 45-minute budget.

## 2. Datasets chosen and what we learned about them

| | PrototypeBench → **NewtypeBench** | SWE-bench Multimodal |
|---|---|---|
| HF id | `banyaaiofficial/prototypebench-v1` **redirects to** `newtype-2038/newtypebench-v1` | `SWE-bench/SWE-bench_Multimodal` (sha 4e6662d, 2026-08-18) |
| Size | 123 (mcp-context-forge 68 · bruno 52 · fastapi template 3), all `held_out` | dev 100 (5 repos) · test 480 (11 repos in the snapshot, not 12) |
| Domain fit | FastAPI backend + React/Electron frontend — the target domain | JS/TS UI libraries; every issue has an image |
| Licence | dataset card says **BSL 1.1** (GitHub repo badge says MIT) — clarify before publishing | MIT (SWE-bench) |
| Scorer | upstream harness, Docker pytest; `pbench score` needs a prior `extract`, so we call `harness.score.score_patch` directly with the dataset's F2P/P2P lists | official `swebench` harness with prebuilt public images |
| Scorer validation | gold patch of `fastapi-1396` → score 1 (F2P 1/1, P2P 26/26) in 40 s | gold patch of `marked-1262` → resolved (F2P 4/4) in 49 s |
| Gotchas | bruno (52) needs a Playwright + Electron + Xvfb image — not built in the pilot; PR-description problem statements may leak solutions (dataset `notes` field says so) | swebench **4.1.0 refuses** local test-split grading, **5.0.2 allows it**; instance `created_at` and `base_commit` date disagree for some rows |

Published anchors and why they are not ARM B substitutes:

- PrototypeBench README smoke: Opus **4.7**, n=20, 600 s timeout, prompt *forbids running tests* → 30 %. Different model, budget and rules.
- Anthropic: Opus 4.8 **38.4 %** on SWE-bench MM test split with an internal harness. Different scaffold (not Claude Code), test split only.
- Open scaffolds (SWE-agent + GPT-4o / Sonnet 3.5) ≈ 12 % on dev — a decade-old (in model terms) anchor for "raw agent".

Decision: run ARM B ourselves under identical conditions; quote the anchors only as context.

## 3. Protocol

1. **Plan** (`scripts/plan.py`): per dataset → per repository → instances sorted by the commit date of `base_commit`, oldest first.
2. **Harness phase, task-blind** (ARM A only): fresh clone at `base_commit`.
   - *Cache miss*: `har env init --profile <inferred>` (default for web signals, cli otherwise; the agent may re-scaffold once) → Sonnet 5 session with `.har/ADAPT-PROMPT.md` + benchmark rules (`prompts/har-adapt.md`; no task, no instance id; it may launch/verify slot 1 itself; must not touch product code).
   - *Cache hit*: cached `.har/`, `AGENTS.md`, `CLAUDE.md`, `.claude/` copied on; `har env maintain` produces the drift report.
   - **Runner gate** (independent of the agent): `har env doctor --json` → `har env launch 1` → `har env verify 1 --json` → `har env verify 1 --full --json`. Failure output is the only feedback into the next task-blind round (≤3 adaptation rounds / 100 min, ≤2 drift rounds).
   - Gate pass → harness committed on top of `base_commit`, snapshot cached per repo with history (`.har-cache/<repo>/meta.json`).
3. **Solve phase**: one shared prompt (`prompts/task.md`) with an arm-specific environment note (`prompts/env-har.md` / `env-raw.md`). Same model, timeout, permissions, downloaded image assets. Full stream-json transcripts kept. Raw arm has `har` disallowed.
4. **Patch**: working tree vs harness commit (A) / base commit (B), minus harness-owned paths, minus files touched by the hidden test patch.
5. **Score**: dataset's own harness. Gold-patch scoring available as a sanity check (`--gold`).
6. **Evidence**: `results/events.jsonl` (timestamps), `runs/<id>/run.json`, transcripts, `.har/runs` records, `NOTES.md` lab notebook, `scripts/analyze_session.py` for per-session forensics.

## 4. Implementation notes (for reproducibility)

- Tooling: `@osfactory/har` 1.14.1, Claude Code 2.1.267, swebench 5.0.2, Docker 29.7.2, uv; har-project `f6f9fbd`.
- `benchmarks/saas-har/` mirrors `benchmarks/swebench-har/` (uv project, `config.yaml`, `prompts/`, `scripts/lib/`), but drives **Claude Code** instead of Codex and adds: commit-date ordering, per-repo harness cache with drift check, gold scoring, session forensics.
- Nested Claude Code sessions run with `CLAUDECODE` unset, `--no-session-persistence`, `--output-format stream-json --verbose`.

## 5. Results (pilot, interim — campaigns 1 and 2 complete, campaign 3 running)

Full table: `results/REPORT.md` (generated). Solve = Opus 4.8 session only; setup = Sonnet 5 adaptation/drift sessions plus runner gates.

| Instance | Repo / stack | A (HAR) | B (raw) | A solve | B solve | Harness setup for this commit | Why unresolved |
|---|---|---|---|---|---|---|---|
| `fastapi-1396` | FastAPI+React+Postgres, oldest commit | ✗ | ✗ | 17 turns, $0.54, 3.5 m | 18 turns, $0.47, 1.9 m | fresh: 3 rounds, $8.94, 57 m | both return 404 with the codebase's existing message; hidden test asserts `"User not found"` (spec ambiguity) |
| `fastapi-1543` | same, +1 day | **✓** | **✓** | 6 turns, $0.22, 2.4 m | 9 turns, $0.24, 0.7 m | cache hit → 1 drift round, $0.28, 11 m | — |
| `fastapi-2104` | same, +1 day (real feature: pwdlib/Argon2) | ✗ | ✗ | 33 turns, $1.03, 6.2 m | 46 turns, $1.45, 4.8 m | cache hit → gate passed untouched, $0, 3 m | hidden tests require `verify_password` to return a tuple; both kept `bool` (spec ambiguity) |
| `marked-1262` | JS markdown lib, cli profile | **✓** | **✓** | 9 turns, $0.38, 1.6 m | 12 turns, $0.42, 1.4 m | fresh: 1 round, $1.47, 8 m | — |
| `marked-684` | same, +7 months | **✓** | **✓** | 10 turns, $0.36, 1.4 m | 14 turns, $0.51, 1.7 m | cache hit → gate passed untouched, $0, 0.7 m | — |

Totals so far: **A 3/5, B 3/5, per-instance outcomes identical.** Two of the four failures are dataset specification issues shared by both arms, not environment or reasoning failures. HAR setup cost: $10.41 and ~80 min across two repositories, amortised over 5 solves; 3 of 3 cache reuses launched and verified, 2 of 3 without any change (the third failed only on a line-number-keyed lint exemption).

Invalidated runs (kept in `results.jsonl` for provenance, superseded by re-runs): three solve sessions at 19:41–19:47 hit the claude.ai usage limit and returned in 1 turn with `is_error: true`.

## 6. Observations and findings

**Benchmark / methodology**

1. **PR-derived problem statements under-specify what the hidden tests check.** Two of three FastAPI-template instances fail both arms on a message string and on a return-type shape that the PR body never mentions. A full study needs a secondary failure taxonomy (functional-but-mismatched vs wrong vs no patch), ideally via a second scorer that runs only behavioural assertions, or by human/LLM adjudication of "spec ambiguity" failures.
2. **Easy instances do not separate the arms.** All five pilot instances were solved (or failed) identically; Opus 4.8 sets up Postgres via Docker in under two minutes on its own. Stratify by difficulty (gold patch size, number of files, whether an environment is needed to reproduce) and oversample hard/UI-heavy instances (Chart.js, p5.js, bruno).
3. **The plan on a usage-capped plan is fragile.** Use API-key billing for the full study; the runner now marks `is_error` sessions and `--resume` re-runs them.
4. **Launch side effects leak into patches.** HAR's launch regenerates files (`routeTree.gen.ts`, `package-lock.json`); the runner now snapshots dirty files before the solve and excludes untouched ones from the graded patch.
5. **Readiness gate policy matters.** Requiring full verify green would have dropped the FastAPI repo from ARM A for a Python-3.13-only test bug; the soft-gate policy (doctor + launch + quick verify, full-verify recorded as harness quality) keeps the comparison unbiased.

**HAR product findings** (from the task-blind adaptation transcripts)

1. `env.template` substitution only knows a fixed allow-list of ports (`DB_PORT`, `MINIO_PORT`, `BROWSER_PORT`, …); infra lanes such as `mailpit-smtp` cannot be templated, so when `setup-infra` scans to a free port the app keeps a stale one. Sonnet worked around it with a `post-launch.sh` hook (`runs/…-1396/har/repo/.har/hooks/post-launch.sh`).
2. `har env maintain --finalize` re-adds the stock `lint` stage to `stages.json` and `verificationStages` on every run, even after the adapter deliberately removed it (duplicate of `frontend-lint`).
3. The scaffold's docs did not answer the adapter's questions about launch/PM2/infra behaviour: it read the compiled `dist/index.js` in 21 shell commands (round 1) and 12 (round 2).
4. Toolchain pinning: the default profile ran the project's backend under the host's Python 3.13 although the repo targets 3.10 (Dockerfile). Two pre-existing tests and mypy fail only for that reason; the adapter scoped them out instead of pinning. A `HARNESS_PYTHON_VERSION`-style knob (or honouring `.python-version` / `requires-python` upper bounds) would remove a whole failure class.
5. Adapters express "known pre-existing failure" exemptions fragilely (exact line numbers) — the exemption broke on the very next upstream commit and cost a drift round. Guidance (or a first-class `knownFailures` field in `stages.json`) would help.
6. Compose project naming: HAR prefixes `har-`; external tooling that wants to stop infra must know that.

**What the HAR arm actually used**

- Every HAR-arm solve ran `har env verify 1 --full` at least once (1–3 times) and never launched, completed or tore down slots (as instructed). Opus read `AGENTS.md`/`.har/README.md` and used the harness as the verification path; it did not need `har env logs/status` except once.
- Quick verify (compile/import/health) took seconds; full verify (pytest + lint + 41 Playwright specs) about two minutes on the FastAPI template — the main source of ARM A's longer wall-clock on easy tasks.

## 7. Recommendations for the full study

1. **Scale and sampling**: run all 71 backend NewtypeBench instances (mcp-context-forge 68 + template 3) and the SWE-bench MM dev split (100), then submit test-split predictions via sb-cli or grade locally with swebench ≥5.0.2 (disk: prebuilt images ~1–3 GB each). Add bruno (52) once the Playwright+Electron scorer image is built.
2. **Difficulty strata**: pre-compute gold-patch size, files touched, and "needs running services to reproduce" per instance; report resolved rate per stratum. Expect HAR's effect, if any, to concentrate in the "needs services / UI" stratum.
3. **Failure taxonomy**: classify every unresolved pair (spec-ambiguity vs functional error vs environment error vs timeout) with a rubric; report arm differences within each class.
4. **Harness metrics to keep**: adaptation cost/time per repo, cache-hit rate, gate-pass-unchanged rate, drift rounds per commit, `full_verify_ok`, harness files touched, product files touched (must be 0), HAR commands per solve.
5. **Controls**: (a) same-model ablation where ARM B is given HAR's `AGENTS.md` text but no launched slot; (b) ARM A with a weaker solve model (Sonnet 5) to test whether the harness substitutes for model capability; (c) repeat each instance ≥3 times to estimate variance (all pilot runs are n=1).
6. **Operations**: API-key billing; serialize default-profile repos (shared port lanes); pin `swebench==5.0.2` and the NewtypeBench snapshot sha; keep `NOTES.md` as the audit trail.


---

# Interpretation: what this design can and cannot support

Written 2026-09-11, before the first protocol-v2 campaign, so that the limits are on record
independently of what the numbers turn out to be.

## Claims the instrumentation supports

1. **Behavioural adoption.** Whether an agent launches the app, runs the project's real checks,
   and verifies at all, when nothing in its prompt asks for it. Both arms get one byte-identical
   minimal prompt (hashed and asserted per run), so a difference here is attributable to the
   repository's contents. Evidence: full stream-json transcripts, classified per session, plus the
   harness's own `.har/runs` records.
2. **Harness economics.** Cost and wall clock of the first task-blind adaptation per repository,
   then per-commit drift cost; cache-hit rate; how often a cached harness passes the runner's gate
   unchanged; how often the soft gate was needed; whether adaptation ever touched product code
   (must be zero).
3. **Effect-size estimate** for resolution rate, per repository and per dataset, with the paired
   structure needed for a proper test later.

## Claims it does not support, and why

| Limitation | Why it matters | Mitigation |
|---|---|---|
| **One attempt per arm per instance** (n≈25 paired) | Agent runs are stochastic; a two-instance gap is indistinguishable from noise. This campaign estimates an effect, it does not test one | repeat the same instances with additional attempts; every run is recorded separately, so repeats can be added later without redoing anything |
| **Binary scoring only in the result rows** | A real quality difference can hide: an arm may pass more FAIL_TO_PASS tests, or regress fewer PASS_TO_PASS tests, and still score 0 | the per-test lists are stored per arm in `score/<arm>/score.summary.json`; surface them as counts in the analysis layer |
| **`ran_tests` under-reports ARM A** | The harness's `verify --full` runs the suite, but the transcript only shows `har env verify`, so the row reads False. Naively this looks like "HAR agents don't test" — the opposite of the truth | derive an effective-verification metric from the `.har/runs` stage records rather than from the command text |
| **`read_harness_docs` is near-useless** | `CLAUDE.md` → `AGENTS.md` is injected as automatic context, not read through a tool, so the metric is almost always False even when the agent clearly followed it | drop it, or rename to "explicitly opened the harness docs" |
| **No failure taxonomy** | In protocol v1, two of four failures were dataset specification ambiguity (an exact error string; a changed return type), shared by both arms. Without classification, "HAR did not help here" is anecdotal | semi-automatic classification from scorer logs (empty patch / timeout / F2P assertion text / P2P regression) plus adjudication of the ambiguous cases |
| **No paired statistics or strata** | No p-value, and no answer to *where* an effect lives | McNemar on the paired table (A✓B✗ vs A✗B✓); stratify by repository, by gold-patch size and file count, and by whether reproducing the bug needs running services |
| **Contamination differs by dataset** | SWE-bench Multimodal dev instances are 2018–2021 JavaScript and very likely in training data — consistent with both arms solving `marked` in about a minute. NewtypeBench is held out after 2026-01-01 | report the two datasets separately and treat NewtypeBench (especially `IBM/mcp-context-forge`) as the primary evidence; the dev split is a control for "easy, probably-seen" tasks |
| **ARM A's repository carries one extra commit** | The harness commit is visible in `git log`, a small asymmetry inherent to the intervention | stated as a limitation; the commit message and author are neutral |
| **Frontend instances are not graded** | `usebruno/bruno` (52 of 123 NewtypeBench instances) needs a Playwright + Electron + Xvfb scorer image that is not built | either build it or scope the paper to backend instances and say so |

Everything in the "mitigation" column except repeats is computable from artifacts this campaign
already stores. Nothing there requires re-running an agent.

## Analysis backlog — implemented in `scripts/analyze.py` (2026-09-11)

`uv run scripts/analyze.py --protocol v2` reads only stored artifacts (no agent, no scorer re-run)
and writes `results/ANALYSIS.md` + `results/analysis.jsonl`. Items 1–5 and 7 below are automatic;
item 6 produces a first-pass category per unresolved arm and still needs adjudication for the
"target tests fail" cases, which is where dataset specification ambiguity hides.

It already corrects the metric that would have been misread: on the first two v2 instances
`ran_tests` is 0/2 for ARM A from the transcript, but the harness's own `.har/runs` records show
`typecheck`, `unit-tests` and `lint` executed in both, so **"project checks actually ran" is 2/2
for ARM A and 1/2 for ARM B**.

1. Per-test outcome columns: FAIL_TO_PASS passed / total, PASS_TO_PASS regressed.
2. Effective-verification metric from `.har/runs` stage records; retire `read_harness_docs`.
3. Verification dynamics from transcripts: verify attempts, how many failed, whether a failure was
   followed by another edit (did verification change the agent's behaviour?).
4. Gold-patch overlap: file-level and line-level similarity to the reference PR.
5. Difficulty strata from the hidden gold patch: lines changed, files touched, and whether the
   change is in code that needs services running to exercise.
6. Failure taxonomy with a fixed rubric, adjudicated case by case, reported per arm.
7. Paired statistics: contingency table, exact McNemar, and confidence intervals per stratum.


---

# Protocol v2 campaign — results (2026-09-11)

26 paired instances across 4 repositories, plus a 23-instance ablation. One attempt per arm.
Generated tables: `results/REPORT.md` (outcomes, cost, behaviour) and `results/ANALYSIS.md`
(per-test detail, gold overlap, failure categories, paired statistics). Chronology and incidents:
`NOTES.md`.

## Outcomes

| Arm | Resolved | Total solve cost | Median solve cost |
|---|---|---|---|
| **A — HAR** | **17 / 26** | $50.91 | $1.24 |
| **B — raw** | 15 / 26 | $29.36 | $0.84 |
| **B′ — raw + verify instruction** (23 of those instances) | 12 / 23 (A 15, B 12 on the same 23) | $27.02 | $0.97 |

Paired discordance: **A-only 3** (`marked-1683`, `marked-1889`, `marked-2483`), **B-only 1**
(`Chart.js-7951`). Exact McNemar **p = 0.625**. The difference is **not statistically supported**
at this sample size; it is an effect-size estimate.

Per repository:

| Repository | n | A | B | B′ |
|---|---|---|---|---|
| `markedjs/marked` | 14 | **11** | 8 | 8 |
| `IBM/mcp-context-forge` | 6 | 3 | 3 | 3 |
| `fastapi/full-stack-fastapi-template` | 3 | 1 | 1 | 1 |
| `chartjs/Chart.js` | 3 | 2 | **3** | — |

The entire aggregate difference comes from one repository. On the two backend pools the three arms
are identical; on Chart.js the raw arm is ahead.

## The behavioural result (the robust one)

| Behaviour | A | B | B′ |
|---|---|---|---|
| Got a working environment | **26/26** | 16/26 | 23/23 |
| Verified anything at all | **26/26** | 18/26 | 22/23 |
| `har env launch` | 26/26 | 0 | 0 |
| `har env verify --full` | 26/26 | 0 | 0 |
| Project check stages recorded in `.har/runs` | **26/26** | n/a | n/a |

Every ARM A session launched a slot and ran the project's real checks — confirmed from HAR's own
run records, not just the transcript. The raw arm skipped verification in 8 of 26 sessions and
failed to get a working environment in 10 of 26. On `Chart.js-7951` it said so explicitly:
*"the repo's dev dependencies aren't fully installed here, so I couldn't run the Karma/rollup
pipeline."*

## What the ablation settles

B′ (the v1 "set up and verify" instruction, no harness) scores **12/23 — identical to plain B**, at
**18% higher cost**, and beats ARM A on **no** instance. It recovered one of the three A-only
instances (`1683`), failed the other two, and broke one instance both other arms solved (`1739`,
by hand-editing build outputs).

**"HAR is just a verification nudge" is not supported.** Equally, the harness's outcome advantage
remains unproven.

## The counter-example, reported with equal weight

`Chart.js-7951`: A ❌ / B ✅. The oracle is a **pixel fixture** (canvas render vs a committed PNG).
ARM A, having run the browser suite green, edited 6 files including the shared canvas helper and
broke the fixture; ARM B — which could run nothing — edited only the bar element and matched the
reference rendering. **Local verification does not constrain a pixel-comparison oracle, and on this
task class it encouraged over-reach.**

## Failure taxonomy (unresolved arms)

| Category | A | B | B′ |
|---|---|---|---|
| partial: some target tests pass | 5 | 5 | 5 |
| target tests fail | 4 | 6 | 6 |
| no patch / timeout / gate failure / apply failure | **0** | **0** | **0** |

No arm ever produced an empty patch, timed out, or failed to apply. Where the arms lose, they lose
on specification detail, not on infrastructure. Three instances are dataset artefacts:
`fastapi-1396` (exact error string), `fastapi-2104` (undocumented tuple return type), `mcp-3269`
(all three arms converge on exactly 3/20 target tests, pinned to database constraint names).

## Harness economics

| Repository | First adaptation | Drift afterwards |
|---|---|---|
| `fastapi/full-stack-fastapi-template` | 3 rounds, $8.94, 57 min | 1 round, $0.28; then $0 |
| `markedjs/marked` | 1 round, $1.47, 8 min | 2 rounds, $1.00 total across 2018→2022 |
| `IBM/mcp-context-forge` | 2 rounds, ~$4.40, 68 min | 1 round, $0.55 (a **flaky** suite, not real drift) |
| `chartjs/Chart.js` | **1 round, $3.54, 21 min** | $0 across 3 commits |

Total harness investment **$20.18** for 26 instances. 21 of 24 cache reuses passed the runner's
gate with no change at all. Two genuine drift repairs were maintainer-grade: following `marked`
from a 2018 lint pin to its current script, and from `lib/marked.js` to the `lib/marked.cjs` +
rollup build three years later. The Chart.js adaptation solved the browser problem unprompted —
Chromium fetched via Playwright into a slot-local directory, karma pointed at the versioned binary.

## Cost

ARM A costs **1.7× ARM B** overall (median 1.5×). Two outliers explain much of it: `mcp-3262`
($3.32 vs $0.33, where the handoff protocol left the agent idling) and `Chart.js-8567` ($13.59,
158 turns, 28 edits, 3 full verifies over 1252 karma specs — and resolved).

## Honest summary

1. **Behaviour: demonstrated.** A HAR repository makes launching and verifying the default, 26/26,
   with evidence in the harness's own run records.
2. **Outcomes: not demonstrated.** 17/26 vs 15/26, p = 0.625, effect confined to one repository,
   reversed on pixel oracles.
3. **Mechanism: partially constrained.** Not reducible to a verify instruction (the ablation ties
   plain raw), but not isolated to the harness either at this n.
4. **Cost: real.** 1.7× for the paired arms; the harness itself was $20 for four repositories.


## Contamination: direct evidence, and what it implies for the next campaign

**The finding.** On `markedjs__marked-1889` the maintainer's test patch *creates*
`test/specs/new/whiltespace_lines.{html,md}` — with that typo. The string "whiltespace" appears
nowhere in the repository at `base_commit`, nowhere in the problem statement, and nowhere in the
hints. **ARM A independently created a file with exactly that misspelling.** Chance is not a
plausible explanation; this is memorisation of the upstream 2020 commit.

Across the campaign, 16 of 47 test-writing sessions reproduced a maintainer test filename exactly.
Most are unremarkable — `marked-spec.js`, `marked.json`, `core.plugin.tests.js` are the obvious
places to add a case. The invented-name matches are not: `whiltespace_lines`, `adjacent_lists`,
`html_comments`.

**Why it lands where it hurts.** The entire aggregate A>B difference comes from one repository:

| Repository | A | B | contribution to A−B |
|---|---|---|---|
| `markedjs/marked` (2018–2022, public JS) | 11/14 | 8/14 | **+3** |
| `chartjs/Chart.js` (2020–2021, public JS) | 2/3 | 3/3 | −1 |
| `IBM/mcp-context-forge` (held out, 2026) | 3/6 | 3/6 | 0 |
| `fastapi` template (held out, 2026) | 1/3 | 1/3 | 0 |

`marked-1889` is one of the three discordant wins, and it is the instance with direct memorisation
evidence. The other two (`1683`, `2483`) are 2019 and 2022 commits from the same public repository —
contamination-prone, without direct evidence either way.

**Consequence, and a revision of the earlier recommendation.** In the limitations section above I
listed contamination as a date-based concern and recommended repeats as the first next step. The
evidence now says otherwise, and the ordering changes:

1. **Scale on held-out instances first.** `IBM/mcp-context-forge` has 68 instances, all merged after
   2026-01-01, in the backend-SaaS domain the study is actually about; its harness is already cached,
   so setup is $0 and drift has been ~12% of commits at $0.52 each. This buys statistical power *and*
   validity at the same time. The same argument applies to the rest of NewtypeBench once the bruno
   frontend scorer image is built (52 more instances).
2. **Repeats second, and on the held-out pool.** k=3 on held-out instances converts each into a rate
   and estimates variance. Repeating the `marked` instances would measure the stability of a result
   that is already suspect at the source — the wrong thing to spend on.
3. **Report the `marked` pool with the caveat attached.** It is still useful as a contaminated-control
   contrast: if an effect appears on memorised tasks and vanishes on held-out ones, that is itself a
   finding about what the harness does and does not buy.

The practical reading: **prefer recent, held-out repositories over re-running the ones already
measured.** A larger number on a contaminated pool is a more confident wrong answer.

## Verification-quality ideas for HAR (from the test-writing analysis)

Ranked by value over effort. None can guarantee matching a specification the agent never sees; what
they buy is raising the floor.

1. **Red-green guard stage** (deterministic, no LLM): stash the non-test part of the diff, run the
   agent's new tests and require them to fail; restore and require them to pass. Catches "changed
   behaviour, wrote no test" (`marked-1889`, raw arm) and "my test passes at baseline too". One agent
   did this by hand on `mcp-3325`, the best-behaved session of the campaign. Fits `stages.json` as a
   `test-guard` stage with no new concepts.
2. **Differential / fuzz stage** for parser- and formatter-shaped repos: generate inputs along the
   dimensions the diff touches (escapes, whitespace, nesting, delimiters), run old versus new, surface
   the behaviour deltas — exactly the axis both arms under-sampled on `1889` and `2483`.
3. **Visual-diff stage** for pixel oracles: render every affected fixture before and after and surface
   the image diff. Would have made `Chart.js-7951`'s collateral rendering change visible before the
   agent stopped.
4. **LLM test critic** behind a flag: reads the diff and names untested input shapes. Highest ceiling,
   but it adds cost and nondeterminism to verification.
