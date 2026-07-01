# Playwright (browser-e2e)

Mission Control specs live under `tests/`:

| Directory | Purpose |
|-----------|---------|
| `tests/frontend/` | UI flows — extend when you add UI features |
| `tests/api/` | API checks via `request` fixture |
| `tests/a11y/` | axe-core on key pages |

## Run

After `./.har/launch.sh <id>`:

```bash
./.har/stages/browser-e2e.sh <id>
# or included in:
./.har/verify.sh <id> --full
```

## New UI features

Add or update Playwright specs so `browser-e2e` covers the change. Full verification (`verify --full`) must pass before done.
