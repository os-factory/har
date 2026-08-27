## Architecture

Each agent slot gets isolated app ports. Defaults follow `BASE + (AGENT_ID × HARNESS_PORT_STEP)`; when a default is busy, `har env launch` scans the slot lane (`STEP` increments) and writes the resolved ports to `.env.agent.<id>` and `.har/slots/agent-<id>.json`.

Configure how many slots your machine can run in parallel in `.har/stages.json` (`agentSlots`). Bash scripts and the CLI read that first; `harness.env` keeps legacy `HARNESS_AGENT_SLOT_*` exports in sync via `har env maintain --finalize`.

| Service | Agent 1 (default) | Agent 2 (default) |
|---------|-------------------|-------------------|
| Frontend | 3010 | 3020 |
| API | 8010 | 8020 |
| Node debug | 9210 | 9220 |
