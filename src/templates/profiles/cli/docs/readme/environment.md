## Environment

| | |
|--|--|
| **Agent ID** | <id> |
| **Work dir** | Fresh session worktree per launch — see the launch output or `.har/slots/agent-<id>.json` |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under the work dir from the launch output. An occupied slot always blocks a new launch — run `har env teardown <id>` (or `complete <id>`) first, then launch again.

```bash
har env agent <id> status
```
