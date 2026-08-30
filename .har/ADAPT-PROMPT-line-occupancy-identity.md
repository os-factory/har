# Adapt the factory line: occupancy-identity

Installed from `local` into `main-f4c5-har-agent-1-nl2h`.
Program: `.har/lines/occupancy-identity/line.json`

## What just happened

A **factory line** was installed. A line is a *program* — an ordered set of
stations plus a cumulative gate. It is not a verification plugin:

- `occupancy-s0` — registered, **not** in `verificationStages`
- `occupancy-s1` — registered, **not** in `verificationStages`
- `occupancy-s2` — registered, **not** in `verificationStages`
- `occupancy-lab` — registered, **not** in `verificationStages`

`verificationStages` was **not** modified. Default `har env verify --full`
takes exactly as long as it did before this install. This line has no opt-in env var — `har line gate` runs its stages on demand.

## Stations

1. `S0` — Purpose does not survive a relaunch (work: 316)
2. `S1` — Trajectory and usage follow the occupancy (work: 316)
3. `S2` — Ingest mints a new session (work: 316)
4. `S3` — Prove it without a developer's laptop (work: 316)

## Cumulative gate (the ratchet)

A gate stage tagged `fromStation: X` is required at X **and every later
station**. Adding a station must never drop an earlier station's stages.

| Stage | From station | Tier |
|---|---|---|
| `occupancy-s0` | `S0` | full |
| `occupancy-s1` | `S1` | full |
| `occupancy-s2` | `S2` | full |
| `occupancy-lab` | `S3` | full |

Run it with:

```bash
har line gate <station> --line occupancy-identity
```

Never with `har env verify --full` — that is the whole point of the split.

## Declared dependencies (declarations, not installs)

Skills:

- `factory-line` (orchestrator) — install: `repo:.claude/skills/factory-line`

MCP servers:

- `github` (optional) — issue #316 is this line's traveler

HAR does not vendor skill packs or MCP servers. Check they are present, install
them the way your agent normally does, and skip tracker steps for any MCP marked
optional that is missing.

## Warnings from install

- _(none)_

## Your job now

1. Read `.har/lines/occupancy-identity/line.json` and make the stations describe *this* repo's
   work — station titles, `work.source`/`work.ids`, waves.
2. Make each registered stage script real (replace TODO blocks). They live under
   `.har/stages/`.
3. Leave `gate.cumulative: true` and `handoff.autonomousShip: false` alone —
   both are contract, not preference.
4. Do **not** add line stages to `verificationStages`. If a check should gate
   every verify, it belongs in a verification plugin instead
   (`har env add-plugin`), not on this line.
5. Verify the harness still passes as before: `har env verify <slot> --full`.
