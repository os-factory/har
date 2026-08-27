## Do not

- Hand-roll docker/dev-server startup — `launch` is how you run the app (manual testing, browser, screenshots included)
- Work around a failing harness command with ad-hoc setup — fix the harness or report the failure
- Hardcode ports — use agent env / `agent-cli.sh url`
- Run raw `docker compose` for shared harness infra — use `har env setup-infra`
- Start other services of the repo in your slot — only the primary app runs per-slot; shared services are already running
- Edit `.env.agent.<id>` or PM2 ecosystem files by hand
- Run `verify` before `launch` when health or e2e steps need a running server
- Edit the main checkout — all edits go under the session work dir
