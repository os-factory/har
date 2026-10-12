# Protocol

Version **v2** (2026-09-10). Every result row carries a `protocol` field; v1 and v2 rows are
reported separately and must never be pooled.

## Question

A repository can be made *agent-ready* with HAR: a `.har/` harness that launches the app in an
isolated slot, a verification pipeline (`har env verify`, `--full`), and agent-facing docs
(`AGENTS.md`, `.har/README.md`, Claude skills). Does that change **what a coding agent does** and
**how often it succeeds** on real merged-PR tasks in web-SaaS and backend-API repositories?

The claim under test is behavioural as much as it is about pass rates: *with HAR installed,
launching the app, running the project's real checks and verifying before stopping become the
default; without it, a strong model may skip them.*

## Arms

| Arm | Repository state at `base_commit` | Solve model |
|---|---|---|
| **A — HAR** | HAR harness adapted **task-blind**, validated by the runner's gate, committed. No slot launched. | `claude-opus-4-8` |
| **B — raw** | Plain checkout, nothing added. | `claude-opus-4-8` |
| **B′ — raw + verify** (ablation) | Plain checkout, plus the v1 verification instructions in the prompt. | `claude-opus-4-8` |

B′ separates "HAR" from "we told the model to verify". It is optional and reported separately.

## The prompt

One template, `prompts/task.md`, rendered identically for every arm:

```
Repository: `<repo>`, at commit `<sha>`.

Implement the following change in this working tree.

<problem_statement, verbatim from the dataset>
```

Plus, only when the instance carries images, a list of the downloaded image paths.
Nothing else. No environment note, no verification instruction, no ground rules, no mention of
tests, commits, HAR, or the benchmark. `run_one` hashes the rendered prompt per arm and records
`prompt_identical_across_arms`; `scripts/test_saas_har.py` fails if the template regains any
instruction vocabulary.

Everything the HAR arm knows about the harness therefore comes from the repository itself, which
is what HAR ships in a real installation: `CLAUDE.md` → `AGENTS.md`, `.har/README.md`,
`.claude/skills/`.

B′ appends `prompts/ablation-verify.md`, which is the v1 wording.

## What must not leak

The solving agent must not be able to infer HAR, the experiment, or the task's identity from
anything except the repository.

| Channel | Measure |
|---|---|
| Working directory path | Checkouts live at `<work_root>/<sha1(run_id)[:10]>/{a,b,b_prime}/repo`, outside this repository. No "har", no "bench", no instance id. |
| Git branch | `task-base` (config `base_branch_name`). |
| Git author / harness commit message | `dev <dev@localhost>`, `chore: development environment setup`. |
| Prompt | Minimal, arm-independent (above). |
| Hidden data | Gold patch, `test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS` are never written under `runs/` or into any checkout. |
| Instance metadata | `runs/<id>/instance.json` holds the agent-visible view only. |

Residual, accepted: HAR's own worktrees live at `~/worktrees/<branch>-har-agent-1-xxxx`, so an
ARM A agent that launches a slot sees "har-agent" in the path. That is HAR's real naming in real
use, and it only appears after the agent has already chosen to use the harness.

## ARM A: making the repository agent-ready, task-blind

The adaptation model (`claude-sonnet-5`) never sees the problem statement or the instance id
(`prompts/har-adapt.md`, `prompts/har-drift.md`; unit-tested).

1. **Cache miss** — `har env init --profile <inferred>` (`default` for web signals, else `cli`),
   then up to `adapt_max_rounds` adaptation sessions within `adapt_budget_minutes`.
2. **Cache hit** — the cached harness files are copied onto the fresh checkout and
   `har env maintain` produces a drift report; up to `drift_max_rounds` drift-fix sessions run
   only if the gate fails.
3. **Runner gate** (the runner's judgement, not the agent's): `har env doctor --json` →
   `har env launch 1` → `har env verify 1` → `har env verify 1 --full`. The gate's output is the
   only feedback into the next task-blind round.
4. The gate records, before tearing the slot down, **which files launching and verifying dirty**
   (`launch_side_effects`). Then it **tears the slot down**: the solving agent must find the
   repository exactly as a developer would after cloning it.
5. The harness is committed on top of `base_commit`; that commit is the diff base for ARM A.
6. The adapted harness is cached per repository, with its full history, in `.har-cache/<repo>/`.

**Soft gate.** If the rounds are exhausted without `verify --full` passing, readiness falls back
to doctor + launch + quick verify and `full_verify_ok: false` is recorded. Dropping such
repositories would bias ARM A towards repositories that are easy to harness.

The adaptation agent may not touch product code (`harness_touched_product_files` must stay 0).

## Measured behaviour

Classified from each session's stream-json transcript (`scripts/lib/behaviors.py`), for both arms:

`installed_deps`, `started_services`, `ran_tests`, `ran_build_or_lint`, `verified_anything`,
`committed`, `test_files_edited`, and for ARM A `har_any`, `har_launch`, `har_verify`,
`har_verify_full`, `read_harness_docs`.

Because no arm is asked to do any of it, these are the primary behavioural outcomes.

## The graded patch

ARM A's diff base is the harness commit; ARM B's is `base_commit`. The runner looks for the
agent's work in this order: the slot worktree, then a session branch ahead of the harness commit
(the agent may have committed and torn down), then the main checkout. If the working tree is
empty and a stash exists, the stash is popped and the diff retaken.

Three exclusions, all scoring mechanics rather than rules given to the agent:

1. harness-owned paths (`.har/`, `AGENTS.md`, `CLAUDE.md`, `.claude/`, …);
2. files the hidden `test_patch` touches — the scorer re-applies that patch;
3. files in `launch_side_effects` that the agent never edited with a file tool.

Everything dropped is recorded per run (`dropped_files`, `launch_side_effect_files`).

## Scoring

Each dataset's own harness decides, execution-only:

- **NewtypeBench / PrototypeBench** — vendored upstream harness, pytest in Docker;
  `score = 1` iff all FAIL_TO_PASS pass and no PASS_TO_PASS regresses.
- **SWE-bench Multimodal** — official `swebench` (≥5.0.2) harness and its prebuilt images.

`--gold` scores the dataset's own gold patch through the same path, as a scorer sanity check.

## Invalid runs

A session that returns immediately with `is_error` (a usage-capped plan) is recorded as
`status: session_error`, never scored, and re-run by `--resume`. Unattended runs wait
`usage_limit_wait_minutes` and retry up to `usage_limit_retries` times.

## What changed from v1, and why

| | v1 (2026-09-10, 5 instances) | v2 |
|---|---|---|
| Prompt | Shared body **plus** an arm-specific environment note and four ground rules: set up services, verify before stopping, do not commit or stash, do not modify tests | One minimal, arm-identical prompt |
| ARM A slot | Pre-launched by the runner; the prompt named the worktree and told the agent to use `har env verify` | Not launched; the agent decides, guided only by what HAR installed |
| ARM B | Told it had no environment and could set one up | Told nothing |
| Working dirs | `benchmarks/saas-har/runs/<instance-id>/…` (the path said "har" and named the PR) | opaque, outside the repository |
| Behaviour | Not measured (it was instructed) | Primary outcome |

v1 measured "given equal encouragement to verify, does a pre-built harness beat a self-built
one?" — a fair question, but not the one the paper asks, and its prompt imported HAR's workflow
into the raw arm. v1 also revealed the leak that motivated the neutral paths: the v1 raw agent
named its Postgres container `har_pg`, which it could only have taken from its working directory.

v1's five instances stay in `results.jsonl` as protocol v1, with their findings, and are not
compared against v2 numbers.
