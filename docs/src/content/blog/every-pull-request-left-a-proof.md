---
title: Every pull request left a proof
description: On 35 paired SaaS tasks, HAR ran the full verification pipeline every time. The resolve rate stayed close to a plain checkout. The run record is what you gain.
date: 2026-10-12
kicker: Benchmark
leadFigure: pr-pipeline
---

We took 35 merged pull requests and gave each one to the same model twice. `claude-opus-4-8`, one prompt, two checkouts. One checkout had a HAR harness, adapted earlier by another model that never saw the task. The other checkout was the repository as published. Nothing in the prompt asked either arm to install, start, or test.

The picture above is those 35. Each small box is one pull request. On the HAR side every box fills, because every session ran `har env verify --full`. A box with a mark is a pull request the hidden tests accepted. The plain side fills only where the transcript shows some check, and the marks land in almost the same places.

## The pipeline

35 of 35 HAR solves launched a slot and ran the project's full verification pipeline. A thirty-sixth solve did too (`mcp-context-forge-3339`); the scorer then produced no JUnit XML, so that pair is not in the score. One more instance never got a solve: the launch gate found another project's processes on the slot.

The stages are the ones the repository registered. On `marked-1825` the record is smoke, typecheck, unit tests, lint, and readiness, each with a pass and a duration. On the FastAPI template the full tier includes pytest and Playwright. On Chart.js it is the Karma suite. The agent did not get to decide that those commands counted. The stage exited, and the exit was stored.

## The score

Hidden tests resolved **19 of 35** with HAR and **17 of 35** without it. Three pull requests resolved only on the HAR side, one only on the plain side (`Chart.js-7951`, a canvas render against a committed PNG). An exact McNemar test on that 3–1 split gives **p = 0.625**.

The two extra resolves sit in `markedjs/marked`, a public JavaScript library from 2018–2022. On the held-out backend repositories — `IBM/mcp-context-forge` and the FastAPI full-stack template, both after 2026-01-01 — the arms resolved the same 6 of 18. The write-up records a direct memorisation hit on one of the `marked` wins: the hidden test file is named `whiltespace_lines`, typo included, and the HAR session created that name from a prompt that does not contain it.

So the honest summary is the one the picture shows. The pipeline ran on the whole set. The resolve marks did not.

## What it cost

Solve sessions only, Opus tokens from Claude Code's own usage on the final result of each transcript. Making the harness is extra, paid once per repository: about **$20** to adapt the four repos, then about **$1.35** when later commits drifted.

| | HAR | Plain checkout |
| --- | ---: | ---: |
| Resolved | 19/35 | 17/35 |
| Full verification pipeline | 35/35 | 0/35 |
| Solve cost | $91.22 | $72.12 |
| Median solve | $1.29 | $0.88 |
| Solve time, summed | 4.6 h | 2.7 h |
| Output tokens | 703,789 | 555,305 |
| Cache-read tokens | 103.2M | 83.0M |

HAR cost about **1.26×** as much, and it emitted about **1.27×** the output tokens. The input bill is almost all cache reads. Uncached input across the whole HAR campaign was 2,994 tokens. The extra money is the agent staying with the suite — replaying a larger context, writing more output — including one Chart.js session at $13.59 that ran three full passes over 1,252 Karma specs.

## Why the proof is the part you keep

A tie on the hidden tests still leaves a review problem: what did the agent actually run?

The median HAR transcript in this campaign is **510 KB** of stream-json. The median verify record is **3 KB**. The record names the stage, the pass, and the milliseconds. The transcript names tool calls. On the plain arm, a classifier that scans those calls says some check happened in 25 of 35 sessions, and it cannot tell you whether that check was the project suite or `node --check`. Finding out means reading the log.

On the HAR arm the same kind of scan is actively misleading. The tests run inside `har env verify`, so the transcript often lacks a line that looks like `npm test` or `pytest`. The [pilot notes](https://github.com/os-factory/har/blob/main/benchmarks/saas-har/NOTES.md) caught this early: the bash flag said the suite had not run, and the `.har/runs` record showed typecheck, unit tests, and lint. If you grade the campaign from Claude's logs, the arm that verified every time is the one that looks idle.

That is the time the record wins back. One pull request is a 3 KB file against half a megabyte of tool output. Thirty-five pull requests is a table of stages against an afternoon. The exit is also stored against the git tree, so a later edit invalidates it. A sentence in a chat does not.

Local green still has a ceiling. It will not invent the error string a hidden test demands and the problem statement never mentions, and on `Chart.js-7951` a green Karma run sat next to a broken pixel fixture. The record does not raise that ceiling. It makes the floor inspectable: you can see that the pipeline ran, which stages passed, and how long they took, without reconstructing the session.

The method, the per-repository split, and the pair-level table are in the [paper](https://github.com/os-factory/har/blob/main/benchmarks/saas-har/paper/PAPER.md). The rows behind the picture are [`results-public.json`](https://github.com/os-factory/har/blob/main/benchmarks/saas-har/paper/results-public.json).
