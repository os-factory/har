# Releasing HAR

Maintainer guide for cutting `@osfactory/har` releases. Contributors should use [CONTRIBUTING.md](./CONTRIBUTING.md) for day-to-day development; coding agents should read [AGENT.md](./AGENT.md) first.

Releases are driven by [Conventional Commits](https://www.conventionalcommits.org/) on `main`. See [Commit messages](./CONTRIBUTING.md#commit-messages-required-for-releases) for the prefixes that bump semver.

## npm packages

| Package | Published? | Notes |
|---------|------------|-------|
| `@osfactory/har` | **Yes** | Public npm package; global `har` binary |
| `@har/control` | No | `"private": true`; Mission Control source in monorepo |
| `@har/schemas` | No | `"private": true`; consumed via monorepo path in `control/` |

## npm organization (`@osfactory`)

Maintainers must own the **`@osfactory`** scope on npm:

1. Sign in at [npmjs.com](https://www.npmjs.com/) as a project maintainer.
2. Create the **`@osfactory`** organization: [npmjs.com/org/create](https://www.npmjs.com/org/create) (free for public packages).
3. Add other maintainers under **Organization → Members**.
4. Create an **Automation** token with **Publish** access to `@osfactory/har` (and scope-wide publish if you prefer).
5. Add the token as the `NPM_TOKEN` repository secret (see below).

The root `package.json` sets `"publishConfig": { "access": "public" }` so scoped publishes are public by default.

## Test a publish tarball locally

`prepublishOnly` runs `npm run build` automatically. To smoke-test the packed artifact before release:

```bash
npm run build
npm pack
npm install -g osfactory-har-*.tgz
har --help
npm uninstall -g @osfactory/har
rm osfactory-har-*.tgz
```

The tarball should contain `dist/` (bundled CLI + templates + prompts), `control/docker-compose*.yml`, plus `package.json`, `README.md`, `LICENSE`, and the changelog — not the Mission Control app source or test fixtures.

## Automated release pipeline

Maintainers do **not** hand-cut version tags. Merge conventional commits to `main`; the [Release workflow](.github/workflows/release.yml) runs on every push to `main` and, when semantic-release finds releasable commits:

1. Runs full CLI + Mission Control verification
2. Bumps `@osfactory/har`, `@har/control`, and `@har/schemas` to the same version (npm package prepared, **not** published yet)
3. Creates git tag `vX.Y.Z` and a **GitHub Release** (with CLI tarball + compose assets)
4. Pushes **`theosfactory/har-control`** to Docker Hub (`X.Y.Z`, `X.Y`, `X`, and `latest`)
5. Publishes `@osfactory/har` to **npm** only after the Docker push succeeds

If there is nothing to release, verify still runs and publish steps are skipped. If Docker publish fails, npm is **not** published for that tag (fix the image, then use [Publish Docker (manual)](.github/workflows/publish-docker.yml) and publish npm from the tag, or re-run the failed jobs).

## Maintainer secrets

| Secret | Used by |
|--------|---------|
| `NPM_TOKEN` | npm publish for `@osfactory/har` (Automation token with publish access to the `@osfactory` scope) |
| `DOCKERHUB_TOKEN` | Docker Hub publish for `theosfactory/har-control` (PAT with read/write on the repo) |
| `GITHUB_TOKEN` | GitHub Release (provided by Actions) |

Dry-run the next release from the Actions tab (**Release → Run workflow → Dry run**) or locally:

```bash
npm ci
GITHUB_TOKEN=... NPM_TOKEN=... npx semantic-release --dry-run
```

## Version coupling

`@osfactory/har`, Mission Control (`control/`), and `@har/schemas` share one semver. [semantic-release](release.config.cjs) keeps them aligned:

1. `@semantic-release/npm` bumps root `package.json` with `npmPublish: false` (prepare only)
2. [`release/sync-package-versions.js`](release/sync-package-versions.js) syncs `control/` and `packages/schemas/`
3. `@semantic-release/github` creates git tag `vX.Y.Z` and the GitHub Release
4. The Release workflow `publish-docker` job pushes `theosfactory/har-control:X.Y.Z` (plus `X.Y`, `X`, and **`latest`**)
5. The `publish-npm` job publishes `@osfactory/har@X.Y.Z` to npmjs **after** Docker succeeds
6. Installed CLI reads its own `package.json` version and pulls `theosfactory/har-control:<same-version>` on `har control up`

Override with `HAR_CONTROL_IMAGE` / `HAR_CONTROL_IMAGE_TAG`, or use `har control up --build` / `HAR_CONTROL_BUILD=true` to build locally from a git checkout.

## Manual Docker publish

To publish the Mission Control image manually:

```bash
docker login
./release/publish-control-image.sh
```

Releases also publish via the Release workflow automatically. To republish an existing tag, use [Publish Docker](.github/workflows/publish-docker.yml) (workflow_dispatch; set **force** to rebuild if the version tag already exists) or `./release/publish-control-image.sh`.

Docker publish builds `linux/amd64` and `linux/arm64` in parallel on native runners (not QEMU), with per-platform GitHub Actions cache. If the exact `theosfactory/har-control:X.Y.Z` tag already exists, the build is skipped unless **force** is set.
