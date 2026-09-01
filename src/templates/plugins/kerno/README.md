# Kerno plugin

Add deterministic backend/API validation to your harness with [Kerno](https://kerno.io).
Kerno re-runs a committed scenario suite against the app running in an agent slot, using the
slot's own database for greybox checks, and reports a pass/fail with a full evidence trail.

```bash
har env add-plugin kerno
```

## What this installs

| File | Purpose |
|------|---------|
| `.har/stages/backend-validation.sh` | Stage runner. Re-runs the Kerno suite against the running slot over REST |
| `.har/stages/KERNO.md` | Setup and adaptation guide: prerequisites, the one-agent rule, artifacts |
| `tests/kerno/README.md` | This file |
| `.github/workflows/kerno.yml` | Optional CI workflow (opt in with `--with-ci`) |

## Workflow

```
        Code change
             │
       launch slot  +  app running
             │
   typecheck + unit-tests + lint
             │
     backend-validation  ◄── your committed .kerno/scenarios/
             │
          pass/fail  +  evidence
```

## Requirements

- Kerno CLI: `npm install -g @kerno/cli`
- Docker running (Kerno executes scenarios in a sandbox container)
- A Kerno agent bound to the slot's worktree (`kerno init` inside it)
- A committed suite under `.kerno/scenarios/` (validate re-runs, it does not generate)

Kerno runs one agent per machine, so backend validation is serialized across slots by a
fail-fast lock. See `.har/stages/KERNO.md` for the full explanation.

## Quick start after install

```bash
# 1. Install the stage
har env add-plugin kerno

# 2. Install the Kerno CLI and bind an agent to the worktree
npm install -g @kerno/cli
kerno init                       # run inside the slot worktree

# 3. Ensure a suite exists (ask your Kerno agent to generate one, then commit it)
ls .kerno/scenarios/endpoints/

# 4. Launch the slot and start your app
har env launch 1

# 5. Run backend validation
./.har/stages/backend-validation.sh 1

# 6. Validate everything
har env verify 1 --full
```

Per-endpoint run responses and verdicts land in `.har/artifacts/backend-validation/`.
