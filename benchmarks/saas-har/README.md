# SaaS / backend-API HAR benchmark

Paired benchmark on **web-SaaS and backend-API repositories**. The same Claude Code model solves
the same task from the same minimal prompt; the only difference between the arms is whether the
repository was made agent-ready with HAR.

The scored write-up is [paper/PAPER.md](./paper/PAPER.md). The 35-pair comparison
(protocol v2, both arms scored) is [paper/results-public.json](./paper/results-public.json).
The announcement is the journal post [Every pull request left a proof](https://harproject.dev/blog/every-pull-request-left-a-proof/).

| Arm | Repository at `base_commit` | Solve model |
|---|---|---|
| **A — HAR** | `.har/` harness adapted **task-blind** by `claude-sonnet-5`, validated by the runner's gate, committed. **No slot pre-launched.** | `claude-opus-4-8` |
| **B — raw** | Plain checkout. | `claude-opus-4-8` |
| **B′ — ablation** | Plain checkout + the "set up and verify" instructions, to separate HAR from a verification nudge. | `claude-opus-4-8` |

Whether an agent installs dependencies, starts services, runs tests or verifies at all is
**measured from its transcript**, never requested in the prompt. Read [PROTOCOL.md](./PROTOCOL.md)
before interpreting any number; results carry a `protocol` field (v1 rows used a different,
instruction-heavy prompt and a pre-launched slot).

Datasets (`config.yaml`):

- **`newtypebench`** — the PrototypeBench corpus (HF `newtype-2038/newtypebench-v1`, formerly
  `banyaaiofficial/prototypebench-v1`): 123 PR replays on `IBM/mcp-context-forge` (FastAPI),
  `usebruno/bruno` (Electron/React) and `fastapi/full-stack-fastapi-template`. Scored with the
  upstream harness (pytest in Docker; all FAIL_TO_PASS pass and no PASS_TO_PASS regresses).
- **`swebench-mm-dev`** — SWE-bench Multimodal **dev** split (100 JS/TS instances, 5 repos),
  scored with the official `swebench` harness (≥5.0.2 also grades the test split locally).

## Flow

```
plan.py            per dataset → per repo → instances ordered by base_commit date (oldest first)
run_campaign.py    for each repo, in that order:
  run_instance.py
    ARM A  clone@base ─► cache hit? ─► apply .har cache ─► har env maintain (drift) ─┐
                      └─ miss ─────► har env init ─► task-blind adaptation (Sonnet 5) ┤
           gate: doctor → launch → verify → verify --full   (retry task-blind on failure)
           record launch side effects ─► TEAR THE SLOT DOWN ─► commit the harness
           Opus 4.8 solves in the un-launched checkout (minimal prompt)
           patch from slot worktree | session branch | checkout ─► informational verify ─► teardown
    ARM B  clone@base ─► Opus 4.8 solves (same prompt bytes) ─► patch
    score  each patch with the dataset's own harness (+ optional gold sanity check)
report.py          results/results.jsonl → results/REPORT.md (outcomes, cost, behaviour rates)
```

## Setup

```bash
cd benchmarks/saas-har
npm install -g @osfactory/har@latest          # HAR CLI (1.14.1 in the pilot)
claude --version                               # Claude Code CLI, logged in (API-key billing advised)
uv sync --extra dev
# vendored scorer for the NewtypeBench corpus + its Docker images
git clone https://github.com/prototypebench/prototypebench.git .vendor/prototypebench
(cd .vendor/prototypebench && uv sync)
(cd .vendor/prototypebench/harness/docker && \
  docker build -f Dockerfile.backend --build-arg PYTHON_VERSION=3.10 -t prototypebench/backend:latest . && \
  docker build -f Dockerfile.backend --build-arg PYTHON_VERSION=3.12 -t prototypebench/backend-py312:latest .)
curl -sL -o .vendor/newtypebench-instances.jsonl \
  https://huggingface.co/datasets/newtype-2038/newtypebench-v1/resolve/main/instances.jsonl
```

`work_root` in `config.yaml` (default `~/agentbench-work`) is where agent-visible checkouts go;
it must stay outside this repository so no path can reveal HAR or the experiment.

## Run

```bash
uv run scripts/plan.py --limit-per-repo 3                                   # inspect ordering
uv run scripts/run_instance.py --dataset newtypebench \
  --instance-id fastapi__full-stack-fastapi-template-1396 --arm none --gold  # scorer sanity check
uv run scripts/run_instance.py --dataset swebench-mm-dev \
  --instance-id markedjs__marked-684 --arm both --dry-run                    # prints the exact prompt
uv run scripts/run_campaign.py --datasets newtypebench \
  --repos fastapi/full-stack-fastapi-template --arm both --resume
uv run scripts/run_campaign.py --datasets newtypebench --repos IBM/mcp-context-forge \
  --limit-per-repo 6 --arm both --resume
uv run scripts/run_campaign.py --datasets swebench-mm-dev --repos markedjs/marked \
  --arm raw_verify --limit-per-repo 2                                        # B' ablation
uv run scripts/report.py
uv run scripts/rescore.py --run-id <run-id>                                  # re-grade saved patches
uv run scripts/analyze_session.py runs/<id>/har/sessions/solve.stream.jsonl  # session forensics
uv run pytest -q scripts/test_saas_har.py                                    # protocol guards
```

Repositories on the `default` profile share HAR's infra port lanes, so campaigns over such
repositories must run **sequentially**.

## Outputs

```
runs/<run-id>/
  instance.json                     agent-visible task metadata (no gold patch, no tests)
  har/sessions/*.stream.jsonl       full transcripts: adapt-rN, drift-rN, solve
  har/gate-failure-*.md             gate output handed to the next task-blind round
  har/drift-report.txt              `har env maintain` output on a cache hit
  har/artifacts/.har/runs           HAR run records (evidence that verify ran)
  raw/sessions/, raw_verify/…       the other arms
  predictions/{har,raw,raw_verify}.patch
  score/<arm>/                      scorer inputs and outputs
  run.json                          the whole record, including measured behaviour
<work_root>/<opaque>/{a,b,b_prime}/repo   the checkouts the agents saw
results/results.jsonl               one row per arm per instance (append-only, carries `protocol`)
results/events.jsonl                timestamped event log
results/REPORT.md                   generated by report.py
.har-cache/<repo>/                  cached adapted harness + adaptation history
NOTES.md                            lab notebook (chronological, with incidents)
PROTOCOL.md                         the protocol and its rationale
PILOT-REPORT.md                     findings
```
