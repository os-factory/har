# Agent ${AGENT_ID} — Docs / marketing site

> [`AGENTS.md`](../AGENTS.md) · [`.har/README.md`](./README.md) · [`stages.json`](./stages.json)

## Environment

| | |
|--|--|
| **Site URL** | http://localhost:${FE_PORT} |
| **Health** | http://localhost:${FE_PORT}/ |
| **Work dir** | Fresh session worktree per launch — see launch output or `docs/.har/slots/agent-${AGENT_ID}.json` |

**Never edit the main checkout** — launch FIRST, then make ALL file edits under
the work dir from the launch output. Edits hot-reload via `astro dev`; use
`./.har/agent-cli.sh ${AGENT_ID} restart` if a change doesn't take.

This slot runs **only** the Astro site (`HARNESS_PRIMARY_APP=web`). No database
or shared Docker infra.

```bash
./.har/agent-cli.sh ${AGENT_ID} status
./.har/agent-cli.sh ${AGENT_ID} logs web
./.har/agent-cli.sh ${AGENT_ID} health
```

## Readiness — what “agent usable” means

1. **Process ready** — `./.har/agent-cli.sh ${AGENT_ID} health` (HTTP 200 on `/`)
2. **Landing usable** — hero headline is present (wired as `HARNESS_READINESS_CMD`)
3. **Visual proof** — before/after screenshots exist under `.har/artifacts/…/screenshots/`
4. **No credentials** — the public site has no login; no seed data required

### Screenshot handoff (required for UI work)

| Phase | Path (under `docs/`) |
|-------|----------------------|
| before (launch baseline) | `.har/artifacts/browser-e2e/screenshots/before/` |
| after (full verify) | `.har/artifacts/browser-e2e/screenshots/after/` |

Typical files: `landing.png`, `docs-introduction.png`.

When you change the landing page or another route:

1. Add or update a Playwright spec under `tests/frontend/`
2. Update `tests/frontend/visual-proof.spec.cjs` if the route/assertion changed
3. Run `har env verify ${AGENT_ID} --full`
4. In the session handoff, **always** link the **after** screenshots (and **before** when present) from the **session work dir** — not the main checkout (`docs/.har/artifacts/…` in the repo root stays stale)

## Definition of done

- [ ] Full verification returns `"status": "pass"` (`har env verify ${AGENT_ID} --full` or `./.har/verify.sh ${AGENT_ID} --full`)
- [ ] Site is agent-usable (health + readiness + screenshots), not only HTTP green
- [ ] UI changes have Playwright coverage; screenshot artifacts prove the result
- [ ] Changes committed **in the session worktree**
- [ ] User got the preview URL http://localhost:${FE_PORT}
- [ ] Session handoff lists Playwright **after** screenshot paths from the work dir (`.har/artifacts/browser-e2e/screenshots/after/`)
- [ ] Present session handoff and **wait** before `complete`, push, or PR

### Session handoff

After full verify and commit, stop. Include summary, session branch
(`.har/slots/agent-${AGENT_ID}.json`), preview URL, and **Playwright after-screenshots**
(under `<work-dir>/.har/artifacts/browser-e2e/screenshots/after/` — always list the
PNG paths; the main checkout copy is not updated). Never autonomously run `complete`, push, or open a PR. Prefer **Complete + open a PR**
when `gh`/GitHub MCP is available.

Quick loop: `./.har/verify.sh ${AGENT_ID}` (check + health only).

## Project commands (in work dir)

```bash
npm run check       # astro check (quick verify)
npm run drift       # docs ↔ product contract drift
npm run build       # production build
npm run links       # link check (needs lychee on PATH for full local parity)
npm run test:e2e    # Playwright (prefer harness browser-e2e with slot BASE_URL)
```

## Do not

- Hand-roll `astro dev` — `launch` is how you run the site
- Work around a failing harness command with ad-hoc setup
- Hardcode ports — use agent env / `agent-cli.sh url`
- Edit the main checkout — all edits go under the session work dir
- Skip Playwright/screenshot updates when changing visible UI
