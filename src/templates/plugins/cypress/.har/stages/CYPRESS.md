# Cypress (cypress-e2e)

Adapt specs under `cypress/e2e/` for your application. Full verification (`verify --full`) runs this stage when it is listed in `verificationStages` (the plugin adds it).

| Path | Purpose |
|------|---------|
| `cypress/e2e/` | End-to-end specs — extend when you add UI |
| `cypress/support/e2e.js` | Shared commands loaded before every spec |
| `cypress.config.js` | Base URL, spec pattern, artifact folders |

## Run

After `har env launch <id>` and `npm install`:

```bash
npx cypress verify
./.har/stages/cypress-e2e.sh <id>
# included in:
har env verify <id> --full
```

`cypress run` is headless. The bundled Electron browser is the default, so a separate Chrome install is not required. Set `HARNESS_CYPRESS_BROWSER` (`chrome`, `firefox`, `electron`) to pick another installed browser.

## Ports

The stage reads the slot env file and points Cypress at that slot:

| Variable | Source | Cypress |
|----------|--------|---------|
| Frontend | `FE_PORT` (or `HARNESS_FE_BASE_PORT + id * 10`) | `CYPRESS_BASE_URL` → `cy.visit('/')` |
| API | `API_PORT` (or `HARNESS_API_BASE_PORT + id * 10`) | `CYPRESS_API_URL` → `Cypress.env('API_URL')` |
| Health path | `HARNESS_HEALTH_CHECK_PATH` (default `/health`) | `Cypress.env('HEALTH_PATH')` |

Do not hardcode slot ports in specs. A monolith that serves UI and API on one port should set both bases to that origin in `.har/harness.env` (or only assert against `baseUrl`).

The scaffold `api.cy.js` expects `GET /health` to return 200. Change the path, or set `HARNESS_HEALTH_CHECK_PATH`, to match your app.

## Artifacts

Written under the main repo's `.har/artifacts/cypress-e2e/` (not the worktree):

| Path | Contents |
|------|----------|
| `cypress.log` | Full `cypress run` output |
| `screenshots/` | Automatic failure screenshots |
| `videos/` | Present when you set `video: true` in `cypress.config.js` |

Video recording is off by default (`video: false`), matching current Cypress. Turn it on in config when you want a video per spec.

Exit codes use `--posix-exit-codes`: `0` when every spec passes, `1` when Cypress fails. The stage propagates that code. Without the flag, Cypress exits with the number of failed tests.

## Linux libraries

`npx cypress verify` checks that the Electron binary can start. If it reports missing libraries, install the packages listed in the [Cypress Linux prerequisites](https://docs.cypress.io/app/get-started/install-cypress#Linux-Prerequisites) and verify again.

## Existing Cypress projects

`add-plugin` will not overwrite a `cypress.config.js` you already have. Point `specPattern` at your specs, keep artifact folders under `.har/artifacts/cypress-e2e/`, and let the stage export `CYPRESS_BASE_URL` rather than a fixed `baseUrl`.

## New UI features

Add or update a spec so `cypress-e2e` covers the change. Prefer one file per feature under `cypress/e2e/<feature>.cy.js`. Full verification must pass before done.

## CI

`har env add-plugin cypress --with-ci` copies `.github/workflows/cypress.yml`, the official `cypress-io/github-action@v7` recipe. Change `start` and `wait-on` to this repo's dev command and URL.

## Plugin updates

When HAR ships a new plugin template version, merge drift from:

```bash
har env maintain
# review .har/maintain/plugins/cypress/
```

Or refresh all plugin-owned files:

```bash
har env add-plugin cypress --force
```
