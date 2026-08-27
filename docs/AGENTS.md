# HAR docs site — Agent Development Guide

Astro marketing site + Starlight documentation for HAR
(<https://harproject.dev/>).

Part of the har monorepo — this app has its own harness (`docs/.har/`). For the
CLI package, Mission Control, or the index of all harnesses, see the root
[`AGENTS.md`](../AGENTS.md).

## Stack

- Astro 7 + Starlight, React islands, Playwright for browser-e2e / screenshots
- Node.js ≥ 22.12

## Layout

```
src/pages/           landing + blog routes
src/content/docs/    Starlight documentation
src/styles/          landing + Starlight theme
tests/               Playwright (frontend, api, a11y, visual-proof)
.har/                agent harness (launch / verify / screenshots)
```

## Agent environment

<!-- har:agent-environment:start -->
## HAR / agent environment

This repository uses a `.har/` harness. It is **how you run and verify this
project** — launch a slot for live apps, browsers and screenshots; never
hand-roll docker or dev-server startup. If a harness command fails, fix the
harness or report it; do not fall back to ad-hoc commands.

1. **Launch first** — `har_launch_environment` / `har env launch <id>`. Make ALL
   edits under the returned **work dir**, never the main checkout. Bind tracker
   work with `--work-id` / `--work-url` when the task names an issue.
2. **Verify before done** — `har_run_verification` (`full: true`) /
   `har env verify <id> --full`. Commit in the session worktree.
3. **Stop at handoff** — report summary, session branch and preview URLs, then
   wait. Never autonomously `complete`, `teardown`, push, or open a PR.

Occupied slots always block: `complete` / `teardown`, then launch. Customize the
harness only through `harness.env`, `stages.json` + `.har/stages/`, `.har/hooks/`
and `.har/plugins/` — the generated `.har/*.sh` shims are not an editing surface.

Full detail — slot environment, readiness, definition of done, project commands,
commit gate: [`.har/README.md`](.har/README.md) and [`.har/stages.json`](.har/stages.json).
<!-- har:agent-environment:end -->

## Project-specific notes

- **Primary app:** Astro site (`npm run dev` / `astro dev`) — no database.
- **Ports:** slot 1 defaults to **4321** (see `.har/harness.env`); never hardcode.
- **Screenshots:** launch → `.har/artifacts/browser-e2e/screenshots/before/`; full verify → `…/after/` (paths are under the **session work dir**).
- **Session handoff:** list every after-screenshot PNG from the work dir so UI changes are reviewable.
- **Other harnesses:** root `.har/` (CLI) · `control/.har/` (Mission Control).
