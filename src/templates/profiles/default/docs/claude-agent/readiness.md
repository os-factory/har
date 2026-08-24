## Readiness

Adapt this section for the repository. A passing health check means the process
is alive; it does not automatically mean an agent can use the app.

- **Health**: `./.har/agent-cli.sh ${AGENT_ID} health`
- **Agent-usable smoke**: document the login/API/UI workflow agents should try,
  or wire it into `HARNESS_READINESS_CMD` / full verify.
- **Credentials/default data**: document any test users, tenants, projects, or
  settings created by the harness.
- **Skipped full-dev setup**: document anything intentionally omitted from the
  upstream developer setup and the minimal substitute in `.har/`.
