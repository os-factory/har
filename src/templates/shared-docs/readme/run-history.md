## Run history

Every entry point — `./.har/*.sh`, `har env …`, MCP — runs the same packaged runtime and writes the same records under the main checkout `.har/runs/YYYY-MM-DD/`.

With git worktree slots, verification runs code in the worktree but run JSON stays in the main repo `.har/runs/`. Each record includes `workDir` when a slot is active.
