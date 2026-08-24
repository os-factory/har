## Environment

| | |
|--|--|
| **Agent ID** | ${AGENT_ID} |
| **Frontend** | http://localhost:${FE_PORT} |
| **API** | http://localhost:${API_PORT} |
| **Database** | `agent_${AGENT_ID}` on `localhost:${DB_PORT}` (when `db` is in `HARNESS_INFRA_SERVICES`) |
| **Work dir** | Fresh session worktree per launch — see the launch output or `.har/slots/agent-${AGENT_ID}.json` |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. Edits there hot-reload in the running slot; use `./.har/agent-cli.sh ${AGENT_ID} restart` if a change doesn't take. An occupied slot always blocks a new launch — run `./.har/teardown.sh ${AGENT_ID}` (or `complete`) first, then launch again.

This slot runs **only the primary application** (`HARNESS_PRIMARY_APP`). External dependencies and any supporting services run once, shared by all slots — `setup-infra.sh` manages them; never start them yourself.

```bash
./.har/agent-cli.sh ${AGENT_ID} status
./.har/agent-cli.sh ${AGENT_ID} logs api
./.har/agent-cli.sh ${AGENT_ID} health
```
