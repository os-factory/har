# Usage integrity

A factory line (FE-2058) over LLM usage: what `har control sync` ships to HAR HQ
is counted exactly once, in the place it happened.

## The invariants

One definition, `packages/schemas/src/usage-invariants.ts`, used by the tests,
Mission Control (`GET /api/usage/invariants`), `har control check-usage` and the
HQ sync. Each guards a root cause a usage audit found on real data.

| Id | Invariant | Audit root cause | Held back from sync |
|---|---|---|---|
| I1 | A request is stored in one repository | a transcript harvest copied a session into a second repository | yes |
| I2 | A legacy session total is stored once, never beside its session's requests | slot suffix change, createdAt keys, one worktree in four repositories, nested repositories | yes |
| I3 | A session's attributed rows hold exactly its requests' tokens | max-merged Cursor rows, rows above their requests | |
| I4 | A slot's work dir is not the main checkout | a slot swallowing its main checkout's usage | |
| I5 | Cursor cache reads are counted once | Cursor's inclusive input with the reads added again | |

## Stations

| Station | Question the gate keeps asking | Isolation |
|---|---|---|
| `S0` | Does each invariant fail on its audited shape, and does the current pipeline keep them all? Does the sync hold back only the sessions counted twice? | jest + vitest |
| `S1` | Mission Control from source, the built CLI and a capture portal, with otel-hook-shaped OTLP and a Claude transcript for every place a session can be (main, worktree, slot, moves, parallel worktrees, two repositories, nested repository, relaunched slot, retried request, A → slot in B → A): do the invariants hold, and does each request land where it happened, across resends? | sandbox `HOME`, temp SQLite, no Docker, no model |

## Run it

```bash
har line gate S0 --line usage-integrity
har line gate S1 --line usage-integrity   # builds the CLI if dist/ is missing
har control check-usage [--repo <path>] [--json]   # your own Mission Control
```

These stages are absent from `verificationStages`; `S0`'s tests also run in the
ordinary unit suites. CI runs `S1` in the `Usage integrity` job.
