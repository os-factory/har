# SaaS-HAR: verification on every pull request, and what it did to the score

Paired benchmark of Claude Code on web-SaaS and backend-API tasks. One arm sees a repository that was made agent-ready with HAR. The other sees the same commit, plain. Protocol v2, scored comparison of 12 October 2026.

Per-instance rows: [`results-public.json`](./results-public.json). Method and lab notebook: [`PROTOCOL.md`](../PROTOCOL.md), [`NOTES.md`](../NOTES.md), [`PILOT-REPORT.md`](../PILOT-REPORT.md).

## Abstract

We replayed 35 merged pull requests with `claude-opus-4-8` under two checkouts and one prompt. On the HAR checkout the solve session ran the project's verification pipeline every time: `har env launch` and `har env verify --full`, 35 of 35. Hidden tests then resolved 19 of those 35, against 17 of 35 on the plain checkout. Three pull requests resolved only with HAR, one only without it. An exact McNemar test on that split gives p = 0.625.

The HAR solves cost $91.22 against $72.12, about 1.26×. Opus output tokens were 703,789 against 555,305, the same ratio. Almost all of the input bill is prompt-cache reads: 103.2 million tokens against 83.0 million.

The score did not move in a way this sample can support. The artifact did. Each HAR verify writes a run record that names the stages, the exit, and the milliseconds. The median record is 3 KB. The median solve transcript is 510 KB. Reading the record answers "what was tested". Reading the Claude log is how you reconstruct the same fact on the plain arm.

## 1. Question

Does a repository that already contains a task-blind HAR harness change three things for the same coding agent, on real merged pull requests: whether the project's own checks run, whether the hidden tests pass, and what that costs in dollars and tokens?

The harness is adapted once per repository by `claude-sonnet-5`, with no access to the task, then cached and drift-checked at later commits. The solving agent is not handed a launched slot and is not told to verify. Both arms receive the same prompt bytes: the repository, the base commit, and the problem statement.

## 2. Design

| Arm | Checkout at `base_commit` | Solve model |
| --- | --- | --- |
| A — HAR | `.har/` adapted task-blind, gate-checked, committed. Slot torn down before the solve. | `claude-opus-4-8` |
| B — raw | Plain tree. | `claude-opus-4-8` |
| B′ — ablation | Plain tree, plus the older "set up and verify" instructions. Run on a 23-instance subset, not on the later held-out continuation. | `claude-opus-4-8` |

Behaviour is measured, not requested. A result row records whether the session launched a slot, ran `har env verify --full`, typed an install, started services, or ran something the transcript classifier calls a test. Scoring uses the dataset's own harness: NewtypeBench (Docker pytest, FAIL_TO_PASS and PASS_TO_PASS) and SWE-bench Multimodal dev (official `swebench` images).

The scored table keeps the latest protocol-v2 attempt per arm and drops a pair unless both arms completed and both scores are free of `score_error`. Two `IBM/mcp-context-forge` instances fall out. `3442` never solved on the HAR arm: the readiness gate failed at launch because another project's PM2 processes held slot 1. `3339` did solve, and it did run `verify --full`, but the scorer emitted no JUnit XML, so the pair is not in the 35. Every HAR solve that actually started — 36 of 36, counting `3339` — ran the full pipeline.

Protocol v1 (instruction-heavy prompt, slot pre-launched) is stored and is not pooled into these numbers.

## 3. Sample

35 scored pairs, four repositories, one attempt per arm.

| Repository | n | Held out after 2026-01-01 | What the suite is |
| --- | --- | --- | --- |
| `markedjs/marked` | 14 | No (2018–2022) | Node unit tests and lint |
| `IBM/mcp-context-forge` | 15 | Yes | Large pytest suite |
| `fastapi/full-stack-fastapi-template` | 3 | Yes | pytest, lint, Playwright |
| `chartjs/Chart.js` | 3 | No (2020–2021) | Karma in a browser, including pixel fixtures |

`marked` and `Chart.js` are public JavaScript from SWE-bench Multimodal dev, and they are old enough to sit in training data. The notebook records a direct contamination hit: on `marked-1889` the maintainer's hidden test creates `whiltespace_lines`, typo included, and the HAR arm created a file with that spelling. The string is not in the base tree and not in the problem statement.

## 4. Results

### 4.1 The pipeline

| | HAR | Raw |
| --- | ---: | ---: |
| `har env verify --full` recorded | 35/35 | 0/35 |
| `har env launch` | 35/35 | 0/35 |
| Transcript says some check ran | — | 25/35 |
| Transcript says tests ran | 23/35 | 23/35 |

The last row is the trap. On the HAR arm the project's tests run inside `har env verify`. The transcript shows that command, so a bash classifier under-counts "ran tests" and can report a session that executed typecheck, unit tests, and lint as if it had tested nothing. The run record is the correction. On the raw arm the same classifier is the only automatic signal, and it still leaves 10 of 35 sessions with no check at all.

### 4.2 The score

| | HAR | Raw |
| --- | ---: | ---: |
| Resolved (hidden tests) | 19/35 | 17/35 |
| HAR only | 3 | |
| Raw only | 1 | |
| Both | 16 | |
| Neither | 15 | |

Exact two-sided McNemar on 4 discordant pairs split 3–1, under a fair coin, is (1 + 4 + 4 + 1) / 16 = 0.625. The sample estimates a small gap. It does not support a claim that the harness raised the resolve rate.

Per repository:

| Repository | HAR | Raw | HAR cost | Raw cost |
| --- | ---: | ---: | ---: | ---: |
| `markedjs/marked` | 11/14 | 8/14 | $15.24 | $12.56 |
| `IBM/mcp-context-forge` | 5/15 | 5/15 | $54.43 | $51.09 |
| `fastapi/full-stack-fastapi-template` | 1/3 | 1/3 | $2.08 | $1.99 |
| `chartjs/Chart.js` | 2/3 | 3/3 | $19.48 | $6.48 |

The net of two extra resolves sits entirely in `marked`. The held-out backend pool, `mcp-context-forge` plus the FastAPI template, is 6/18 against 6/18, with no discordant pair. On `Chart.js` the plain checkout is ahead by one.

That one is `Chart.js-7951`. The graded test is a canvas render against a committed PNG. The HAR session ran the Karma suite green and also edited the shared canvas helper, which broke the fixture. The raw session could not run Karma, edited only the bar element, and matched the golden. A local green does not see a pixel oracle, and on this task it coincided with a wider edit.

On the 23-instance ablation (the September 11 subset, before the held-out continuation), telling the raw arm to set up and verify scored 12/23. Plain raw on those same instances was also 12/23. HAR was 15/23. The instruction recovered part of the behaviour and did not reproduce the score.

### 4.3 Cost and tokens

Solve sessions only. Opus totals come from Claude Code `modelUsage` on the final result event of each transcript. Adaptation of the harness is paid separately, once per repository: the notebook records $20.18 across the four repositories through 11 September 2026, and $1.35 of later drift. Those dollars are not in the table.

| | HAR | Raw | Ratio |
| --- | ---: | ---: | ---: |
| Solve cost | $91.22 | $72.12 | 1.26× |
| Median solve cost | $1.29 | $0.88 | 1.47× |
| Sum of solve wall clock | 4.6 h | 2.7 h | 1.70× |
| Turns | 1,328 | 1,261 | 1.05× |
| Output tokens | 703,789 | 555,305 | 1.27× |
| Thinking tokens | 288,600 | 217,807 | 1.33× |
| Cache-read input tokens | 103,209,379 | 82,971,802 | 1.24× |
| Cache-write input tokens | 2,249,413 | 1,663,190 | 1.35× |
| Uncached input tokens | 2,994 | 2,468 | 1.21× |

The dollar ratio and the output-token ratio match. The input side is almost entirely cache reads: uncached input is a few thousand tokens per campaign, not per session. The extra HAR spend is the agent staying in the loop while the pipeline runs, plus a larger context being replayed from cache on later turns. It is not a second copy of the uncached prompt.

`Chart.js-8567` is the expensive end of that loop: the HAR session ran three full verifies over 1,252 Karma specs and cost $13.59 on its own. The median HAR solve is $1.29.

## 5. Why the run record is still the result

A campaign that ties on resolve rate can still change the review.

The median HAR solve transcript here is 510,353 bytes of stream-json. Across the 35 solves the runner kept 170 verify records, median 3,186 bytes. One of them, for `marked-1825`, is the whole answer to "what ran":

| Stage | Pass | Time |
| --- | --- | ---: |
| smoke | yes | 64 ms |
| typecheck | yes | 1,671 ms |
| unit-tests | yes | 1,208 ms |
| lint | yes | 844 ms |
| readiness | yes | 3 ms |

Status `pass`, 3.8 seconds, bound to the worktree. You do not recover that list by scanning a Claude log. On the raw arm the evidence is the log: a bash line that might be `npm test`, might be `node --check`, might be absent. The classifier's "verified anything" flag is that scan, automated. It said yes on 25 of 35 raw sessions and it does not name a stage. Distinguishing a real suite from a syntax check means reading the transcript.

That is the time the record buys. For one pull request it is the difference between opening a 3 KB JSON file and reading half a megabyte of tool calls. For 35 pull requests it is the difference between a table of stages and an afternoon in the logs. The same record is what a later commit gate can refuse: the exit is stored against the tree, so an edit after the green run invalidates it. A paragraph in the transcript cannot.

The pipeline running on every task is what makes that table complete. A harness that verifies sometimes still leaves you in the log for the rest.

## 6. Limitations

One attempt per arm. Agent runs move; a two-instance gap is inside that noise, which is what p = 0.625 is saying.

Binary resolve hides partial credit. Several unresolved pairs fail the same hidden assertions on both arms, including cases where the problem statement never states the string or the return shape the test requires. Verification can keep a session inside the checks it can see. It cannot reveal a spec the agent was never given.

`marked` carries direct memorisation evidence, and it is the only repository where HAR leads. The held-out backend pool is a tie. Treat the aggregate 19 against 17 with that split in view.

The raw "verified anything" rate is a transcript heuristic. The HAR pipeline rate is a run record. They are not the same measurement, and the paper reports them that way on purpose.

Frontend NewtypeBench (`usebruno/bruno`, 52 instances) is not in this sample. The Playwright and Electron scorer image was not built.

## 7. Artifacts

| Path | What it is |
| --- | --- |
| [`results-public.json`](./results-public.json) | The 35 pairs: resolve, pipeline, cost, Opus tokens |
| [`../PROTOCOL.md`](../PROTOCOL.md) | Why the prompt is minimal and why v1 is not pooled |
| [`../NOTES.md`](../NOTES.md) | Lab notebook, including the contamination note and the excluded instances |
| [`../PILOT-REPORT.md`](../PILOT-REPORT.md) | Earlier campaign write-up (26 pairs, before the held-out continuation) |
| [`../scripts/`](../scripts/) | Planner, runner, scorer, report |

Raw transcripts, Docker scorer output, and `.har/runs` trees stay on the machine that ran the campaign (`runs/`, gitignored). The public JSON is the comparison those artifacts support.
