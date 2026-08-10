# Playwright (browser-e2e) — docs site

Full verification (`har env verify <id> --full`) runs this stage when
`stages/browser-e2e.sh` is present.

| Directory | Purpose |
|-----------|---------|
| `tests/frontend/` | UI smoke and feature flows — **add a file per UI change** |
| `tests/frontend/visual-proof.spec.cjs` | Full-page before/after screenshots |
| `tests/api/` | HTTP checks via Playwright `request` |
| `tests/a11y/` | Optional axe checks (`npm run test:e2e:a11y`) — not in default full verify |
| `tests/playwright/capture.cjs` | Shared screenshot helper |

## Screenshot proof (before / after)

| When | Phase | Path |
|------|-------|------|
| `launch` | `before` | `.har/artifacts/browser-e2e/screenshots/before/*.png` |
| `verify --full` / `browser-e2e` | `after` | `.har/artifacts/browser-e2e/screenshots/after/*.png` |

Manual recapture:

```bash
./.har/stages/capture-screenshots.sh <id> before
./.har/stages/capture-screenshots.sh <id> after
```

**UI tasks:** update or add Playwright specs so assertions match the new UI, run
full verify, **display** the before/after PNGs inline in the session handoff
(Read tool — not path-only), and attach them to the PR:

```bash
./.har/stages/pr-visual-proof.sh prepare
git add .har/visual-proof
har env verify <id> --full    # commit gate after staging proof
# commit + push + open PR (on approval), then:
./.har/stages/pr-visual-proof.sh comment <pr>
```

## Run

After `./.har/launch.sh <id>`:

```bash
./.har/stages/browser-e2e.sh <id>
# included in:
./.har/verify.sh <id> --full
```

Never hardcode ports — `BASE_URL` comes from the slot env / `browser-e2e.sh`.
