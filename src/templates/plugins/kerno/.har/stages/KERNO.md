# Kerno Backend Validation

The `backend-validation` stage re-runs your committed [Kerno](https://kerno.io) scenario
suite against the app running in an agent slot, deterministically and with no LLM in the
loop. It turns the slot's isolated running app plus its per-slot database into a real
backend-validation target, then leaves a pass/fail exit code and an evidence trail.

Full verify (`verify --full`) runs this stage when `backend-validation` is listed in
`verificationStages` (the plugin adds it for you).

## How it works

For the slot you name, the stage:

1. Acquires a machine-wide lock so two slots never validate at once (see "One agent at a time").
2. Preflights that a Kerno agent is running and bound to this worktree, that Docker is up, and
   that a committed suite exists under `.kerno/scenarios/`.
3. Points Kerno's target config at this slot over REST (the slot's SUT URL and, for greybox, its
   per-slot database).
4. Runs every endpoint's scenarios via `POST /scenarios/run` and reads the verdicts straight from
   the HTTP response.
5. Writes per-endpoint run responses and any fresh `report.json` files under
   `.har/artifacts/backend-validation/`, and exits non-zero if any scenario is not `passed`.

## Prerequisites

- **Kerno CLI** installed: `npm install -g @kerno/cli`.
- **Docker** running. Kerno executes each scenario inside a sandbox container.
- **A Kerno agent bound to this worktree.** Run `kerno init` inside the agent slot's worktree so
  Kerno's workspace path matches the slot. The stage never starts or rebinds the agent itself
  (starting one would kill any other running Kerno agent, see below).
- **A committed suite** under `.kerno/scenarios/endpoints/`. Validate re-runs an existing suite,
  it never generates one. Ask your Kerno agent to generate scenarios first, then commit them.

## One agent at a time

Kerno runs a single agent per machine. Starting a second agent (via `kerno init`) kills any other
running Kerno agent and can tear down its in-flight sandboxes. Because of that, this stage:

- **Never spawns or rebinds** the agent. If none is bound to this worktree, it fails with an
  instruction to run `kerno init` here.
- **Serializes across slots** with a fail-fast lock at `~/.kerno/har-backend-validation.lock`. If a
  second slot runs the stage while one is validating, the second fails fast rather than colliding.

So backend validation runs one slot at a time. Frontend stages (Playwright, and so on) still run
concurrently across slots.

## Configuration the stage reads

All values come from the slot's `.env.agent.<id>` (written by `har env launch`) and `~/.kerno/agent.port`:

| Value | Source | Used for |
|-------|--------|----------|
| `API_PORT` / `SUT_URL` | slot env | the SUT base URL Kerno tests (`http://localhost:$API_PORT`) |
| `DATABASE_URL` / `DB_PORT` | slot env | greybox DB target (`agent_<id>`); omitted for black-box apps |
| `KERNO_AGENT_PORT` or `~/.kerno/agent.port` | Kerno state | which local Kerno agent to call (default `8085`) |
| `KERNO_APP_ID` (optional) | you | pin the application id when Kerno does not surface one (see below) |
| `KERNO_SANDBOX_ENV` (optional) | you | extra env injected into the Kerno sandbox for your scenarios (see below) |

Override the agent port with `KERNO_AGENT_PORT` if you run Kerno on a non-default port.

### Scenario env (`KERNO_SANDBOX_ENV`)

Some suites need runtime values, a test-user email, an API token, a feature flag, that
the scenarios read from the sandbox environment. Pass them as newline- or
semicolon-separated `KEY=VALUE` pairs; keys must be upper-snake-case. They are injected
into the Kerno sandbox verbatim alongside the slot database.

```bash
KERNO_SANDBOX_ENV="KERNO_TEST_USER_EMAIL=dev@example.com;FEATURE_X=on" \
  ./.har/stages/backend-validation.sh 1
```

For an authenticated suite, this is usually where the test user goes. The user must exist
in the slot's seeded database, and the app must accept it (for example a dev-login provider
enabled in the running app).

If Kerno analyzed your app but did not classify it as HTTP-serving, it is omitted from
the workspace's application list. The stage falls back to the analyzed module and logs a
note, so validation still runs. To pin the id explicitly, set `KERNO_APP_ID` (find it via
`kerno_get_applications`, under `unsupported_apps` when this happens).

## Verdicts

Overall pass requires every scenario across every endpoint to be `passed`. A `failed`, `blocked`,
or `not_implemented` scenario fails the stage. `blocked` usually means the target or its DB was not
reachable or a precondition could not be met, so check the run response in the artifacts.

## Artifacts

Under `.har/artifacts/backend-validation/`:

- `<METHOD>_<path>.run.json` for each endpoint: the raw `POST /scenarios/run` response, including
  per-scenario `verdict`, response status/body, and any `potentialBug`.
- Copies of Kerno's own `report.json` files written during this run.

## Running

```bash
# One slot
./.har/stages/backend-validation.sh 1

# As part of full verify
har env verify 1 --full
```

## Adapting per repo

- **Auth and runtime env vars** your scenarios or SUT need at runtime belong in the Kerno config
  (`kerno save-config` via your agent, or the `.kerno/config.yaml` dependency blocks). The stage sets
  only the SUT URL and the slot DB.
- **Black-box only** apps (no slot DB) are fine. Leave `DATABASE_URL`/`DB_PORT` unset in the slot and
  the stage tests over HTTP only.
- **Regenerate on new endpoints.** When you add an endpoint, ask your Kerno agent to generate its
  scenarios and commit them, so the next validation covers it.
