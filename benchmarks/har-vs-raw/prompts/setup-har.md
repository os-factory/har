Adapt this repository's .har harness for frontend issue-fixing by coding agents.

Objectives:
1. Agents must launch the app through HAR, not ad-hoc docker/dev-server commands.
2. The launch stage must create an isolated worktree per agent slot and start the primary web app with all required local dependencies (database migrated/seeded, redis, mail, etc. via setup-infra — not documented as manual steps).
3. The verify stage must run the repo's normal fast checks: typecheck/lint/unit tests relevant to frontend changes.
4. Full verify must also run Playwright browser-e2e through the HAR browser-e2e stage.
5. The harness must document preview URLs, credentials, seed data, and troubleshooting in .har/CLAUDE.agent.md.

Explore first:
- README, package manifests, docker compose, CI, existing e2e setup, dev scripts, env examples.
- Identify the primary app agents will change and run.
- Identify shared dependencies: database, redis, queues, object storage, mail, search, browser services.

Adapt:
- .har/harness.env: primary app, slot port bases, health path, infra services, migrate/seed commands.
- .har/docker-compose.agent.yml: only required shared services, no unused template services.
- .har/scripts/bootstrap-template-db.sh (or equivalent): apply migrations + seed to the template DB automatically (no manual migrate steps).
- .har/env.template: only environment variables this app actually reads.
- .har/ecosystem.agent.template.cjs or launch scripts: start the primary app per slot.
- .har/verify.sh: real checks, with quick vs --full behavior.
- .har/stages/browser-e2e.sh and tests/: make smoke/API/a11y tests meaningful for this app.
- AGENT.md and .har/README.md: explain that HAR is the canonical run/verify path, including **first-time infra setup** (Docker services + template DB migrate/seed) so the app is fully testable without manual steps.

Definition of done:
- har env launch 1 succeeds.
- The preview URL loads.
- har env verify 1 succeeds.
- har env verify 1 --full succeeds and runs Playwright.
- No TODO placeholders or unused template services remain in .har/.
- Record setup time, iterations, failures, and final commit hash.
