## Environment

| | |
|--|--|
| **Agent ID** | <id> |
| **Frontend** | http://localhost:${FE_PORT} |
| **API** | http://localhost:${API_PORT} |
| **Database** | `agent_<id>` on `localhost:${DB_PORT}` (when `db` is in `HARNESS_INFRA_SERVICES`) |
| **Work dir** | Fresh session worktree per launch — see the launch output or `.har/slots/agent-<id>.json` |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. Edits there hot-reload in the running slot; use `har env agent <id> restart` if a change doesn't take. An occupied slot always blocks a new launch — run `har env teardown <id>` (or `complete`) first, then launch again.

This slot runs **only the primary application** (`HARNESS_PRIMARY_APP`). External dependencies and any supporting services run once, shared by all slots — `har env setup-infra` manages them; never start them yourself.

```bash
har env agent <id> status
har env agent <id> logs api
har env agent <id> health
```
