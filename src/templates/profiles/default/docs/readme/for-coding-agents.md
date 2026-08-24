## For coding agents

1. Read repo [`AGENTS.md`](../AGENTS.md)
2. Read this file and `stages.json`
3. After launch, read `.har/CLAUDE.agent.md` for slot URLs and definition of done

Prefer HAR MCP tools or `har env …` for launch, verify, and teardown. Use `./.har/*.sh` only when the CLI is not installed.

Always use `./.har/agent-cli.sh <id> ...` — never hardcoded ports.
