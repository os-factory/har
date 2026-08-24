## For coding agents

**Start here:** read [`AGENTS.md`](../AGENTS.md) at the repo root for a short pointer, then [`.har/CLAUDE.agent.md`](./CLAUDE.agent.md) for full instructions.

Prefer HAR MCP tools or `har env …` for launch, verify, and teardown. Use `./.har/*.sh` only when the CLI is not installed.

Work in the isolated git worktree created by launch. Use `./.har/agent-cli.sh <id> exec ...` to run ad-hoc project commands in that work dir.

When the project needs Postgres, Redis, or similar, add the service to `docker-compose.agent.yml` (or keep one from the menu), list it in `HARNESS_INFRA_SERVICES` in `harness.env`, and use `setup-infra.sh` — never run raw `docker compose` for shared infra. Shared services run once on fixed ports and serve every agent slot.
