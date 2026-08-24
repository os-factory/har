## Do not

- Work around a failing harness command with ad-hoc setup — fix the harness or report the failure
- Edit `.env.agent.${AGENT_ID}` by hand
- Run verify before launch (the simulator and worktree must be set up first)
- Edit the main checkout — all edits go under the session work dir
