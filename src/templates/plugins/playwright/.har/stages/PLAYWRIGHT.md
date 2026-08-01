# Playwright (browser-e2e)

Adapt specs under `tests/` for your application. Full verification (`verify --full`) runs this stage when `stages/browser-e2e.sh` is present.

| Directory | Purpose |
|-----------|---------|
| `tests/frontend/` | UI smoke and flows — extend when you add UI |
| `tests/api/` | HTTP checks via Playwright `request` |
| `tests/a11y/` | axe-core on key routes |

## Run

After `./.har/launch.sh <id>`:

```bash
./.har/stages/browser-e2e.sh <id>
# included in:
./.har/verify.sh <id> --full
```

Adapt selectors and paths in the scaffold specs during harness adaptation.

## New UI features

Add or update Playwright specs so `browser-e2e` covers the change. Prefer one file per feature under `tests/frontend/<feature>.spec.js`. Full verification (`verify --full`) must pass before done.

See the header comment in `playwright.config.js` for harness env vars, artifact paths, and the quick vs full verify contract.

## Plugin updates

When HAR ships a new plugin template version, merge drift from:

```bash
har env maintain
# review .har/maintain/plugins/playwright/
```

Or refresh all plugin-owned files:

```bash
har env add-plugin playwright --force
```
