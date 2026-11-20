# 06 — Mission Control and telemetry

The local dashboard (`control/`): a synchronized projection of repository evidence plus agent usage.
Background: [ADR-0003](../docs/architecture/decisions/0003-session-slot-attribution.md).

## Sync and repositories

- **MC-1** MUST — Mission Control is a projection, not the source of truth: it shows runs, slots, validations, work units and artifacts synced from registered repositories' `.har/` evidence.
- **MC-2** MUST — Sync runs at every activity edge (launch, verify, commit, complete, login) and touches only the repositories in the saved sync selection.
- **MC-3** MUST — A failed or timed-out sync of one repository is reported in one line and does not block the others or the agent's command.
- **MC-4** MUST — Unregister deletes that repository's synced data and blocklists it from automatic re-registration; reset wipes all repositories and the blocklist but keeps portal credentials.

## Views

- **MC-5** MUST — The Factory view derives active, failed and verified state of work units from evidence, and stores explicit state only for business outcomes (completed, abandoned).
- **MC-6** MUST — Repository detail shows active slots, run timeline, expected validation stages with latest results, exact-tree snapshots with their commits, and artifacts.
- **MC-7** MUST — The factory-lines board reads the repository's own `.har/lines.json` and program, is read-only, and flags a line stage present in `verificationStages` as an error.

## Lifecycle and occupancy

- **MC-8** MUST — `har control up` runs Mission Control as a Docker container on an image versioned to the CLI with a named data volume; a container on an older released image is upgraded, while one from a custom image or tag, under an image override, or while the CLI targets another Mission Control is left alone.
- **MC-9** MUST — Launch preflight blocks when `har control up` occupies the slot's allocated port and only warns when it holds the default port but an alternate was allocated.
- **MC-10** MUST — Slot data is scoped to the occupancy, not the slot number: a relaunched slot gets a new occupancy key, a resumed worktree keeps its key, and a slot's trajectory and usage are filtered by it.
- **MC-11** SHOULD — Repository history shows a validated but uncommitted tree as a pending snapshot and keeps two commits that share one content snapshot distinct.
- **MC-12** SHOULD — The slot page shows a header, the verify state and one timeline whose rows expand in place; agent sessions open their trajectory inline and raw events stay behind a debug toggle.

## Telemetry and attribution

- **TEL-1** MUST — Agent hooks export OTLP to `{HAR_CONTROL_API_URL}/api/otel` with a bounded timeout and always exit 0; a dropped telemetry event never fails an agent tool call.
- **TEL-2** MUST — LLM usage is stored as idempotent usage observations (one per provider-reported request/turn/generation), never merged into each other.
- **TEL-3** MUST — Each observation is attributed to the slot binding in force at its timestamp (subagent first, then parent session); bindings come only from evidence (`launch`/`release`, `workspace`, `observed`), never from a guess.
- **TEL-4** MUST — The trajectory ledger is append-only, ordered by producer sequence then timestamp, deduplicated on `(source, sourceEventId, contentKey)`, and records `contentDisclosure` for partial bodies.
- **TEL-5** MUST — Secret attributes (e.g. `authorization`, `api_key`) are stored as `[redacted]`, and bodies over `HAR_TRAJECTORY_MAX_PAYLOAD_BYTES` are truncated.
- **TEL-6** MUST — Trajectory bodies leave the machine for a hosted portal only after an explicit opt-in (`har control trajectory on`), under the same redaction and size policy.
- **TEL-7** SHOULD — `har telemetry off` stops export and Mission Control auto-start while keeping historical rows; `--no-prompts` disables prompt text capture only.
- **TEL-8** MUST — A provider-reported cost wins; otherwise cost is estimated from the model price catalog; an unknown or Cursor-native model has no cost rather than a guessed one.
- **TEL-9** MUST — A newer harvest generation replaces an older harvested usage row; the same or an older generation is refused, and a row OTLP contributed to is never replaced by a harvest.
- **TEL-10** MUST — Transcripts are harvested only into the slot whose work dir matches (a parent-directory session never lands in a child worktree slot), and harvested usage is dropped when OTLP already attributed that session and tool.
- **TEL-11** MUST — Before a portal sync, sessions that break the usage invariants are held back and reported; the rest is sent.
