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

Replace TODO selectors and paths in the scaffold specs during harness adaptation.
