# Releasing HAR

Maintainer guide for cutting `@osfactory/har` releases. Contributors should use [CONTRIBUTING.md](./CONTRIBUTING.md) for day-to-day development; coding agents should read [AGENTS.md](./AGENTS.md) first.

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
4. On `@osfactory/har` → **Settings → Trusted Publisher → GitHub Actions**, register organization `os-factory`, repository `har`, workflow `release.yml`, environment `npm-publish`. The release workflow publishes through npm Trusted Publishing (GitHub OIDC), so no npm token is stored.

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

## Prereleases and the 2.0.0 release

`next` is a prerelease branch ([release.config.cjs](release.config.cjs)): every
releasable merge into it publishes `X.0.0-next.N` to the npm `next` dist-tag and
Docker Hub, without moving `latest`. 2.0.0 is cut by merging `next` into `main`.

### Machine changelog (semantic-release)

Nothing changes in the tooling. semantic-release writes `CHANGELOG.md` and the
GitHub release body from the Conventional Commit titles on the branch, so every
squash-merge title must be conventional, and a breaking one must carry `!`
(`feat!: …`); a `BREAKING CHANGE:` footer in a PR's own commits is lost in the
squash.

- **Prereleases.** Each `2.0.0-next.N` gets its own section in `CHANGELOG.md` on
  `next`, listing only the commits since `2.0.0-next.(N-1)`, under
  *Features* / *Bug Fixes*, and *⚠ BREAKING CHANGES* when a title had `!`
  (only `2.0.0-next.1` so far). The GitHub prereleases carry the same text.
- **2.0.0.** On `main`, semantic-release lists the commits since the last release
  reachable from `main` (the latest 1.x). Prerelease notes do not roll up by
  themselves: what 2.0.0 lists depends on how `next` lands on `main`. The repository
  allows squash and rebase merges only:
  - **squash** (the usual path): `main` gets one commit, so the 2.0.0 notes have one
    entry, the squash title. The `next.N` sections come along in `CHANGELOG.md`,
    below the new 2.0.0 section;
  - **rebase**: every commit of `next` is replayed onto `main`, and the 2.0.0 notes
    list all of them (the `chore(release)` commits are not listed).

  Either way the generated notes are an index, not an explanation. Use a squash
  with the title `feat!: HAR 2.0.0 …` and put the upgrade pointer in a
  `BREAKING CHANGE:` footer of the squash message itself (it is the commit on
  `main`, so the footer is kept and appears under *⚠ BREAKING CHANGES*):

  ```text
  feat!: HAR 2.0.0, one ingest contract and otel-hook as the only agent source

  BREAKING CHANGE: see https://harproject.dev/docs/guides/upgrading-to-2-0/
  (what changes, what the upgrade does by itself, rollback). Requires
  @osfactory/otel-hook <pinned version> or newer; Mission Control image
  theosfactory/har-control:2.0.0.
  ```

  `next` misses the `1.x` entries released on `main` after it branched: keep both
  sides of `CHANGELOG.md` when resolving the merge.

### Human changelog

The curated summary is the **What's new in 2.0** section at the top of the
[upgrade guide](docs/src/content/docs/docs/guides/upgrading-to-2-0.md)
(`https://harproject.dev/docs/guides/upgrading-to-2-0/`). Write it, and check every
claim against `next`, before the `next` → `main` merge. The GitHub release body links
to it (the footer above, or an edit of the release after it is cut), and states:

- the minimum `@osfactory/otel-hook` version (`OTEL_HOOKS_VERSION` in
  `src/core/otel-hooks.ts`, which HAR installs);
- the Mission Control image, `theosfactory/har-control:2.0.0` (same version as the
  CLI; see [Version coupling](#version-coupling)).

The guide's URL is a contract: receivers send it in the
`Link: <…>; rel="deprecation"` header of their 1.x endpoints. Never move or redirect
the page; `docs/check-drift.mjs` fails if it goes.

### 2.0.0 release checklist

1. Bump `OTEL_HOOKS_VERSION` to the first published otel-hook release that has the
   session context and Codex rollout usage (`--codex-rollout-usage`), and check that
   HAR's hooks pass the flags it needs.
2. Write the **What's new in 2.0** section and update the rest of the upgrade guide
   on `next`; full-verify the docs harness.
3. If 1.x needs a last patch (for example the upgrade notice a 1.x CLI prints on a
   `Deprecation` header), release it from `main` before the merge, or add a `1.x`
   maintenance branch to `release.config.cjs` first: after 2.0.0, `main` releases
   only 2.x.
4. Dry-run the release on `next` (**Release → Run workflow → Dry run**).
5. Merge `next` into `main` with a squash, the `feat!:` title and the
   `BREAKING CHANGE:` footer above. Check that `2.0.0` reached npm (`latest`),
   Docker Hub (`theosfactory/har-control:2.0.0` and `latest`) and GitHub Releases.
6. Check that the docs site serves `https://harproject.dev/docs/guides/upgrading-to-2-0/`.
7. Only then may hosted receivers turn on the `Deprecation`, `Sunset` and `Link`
   headers of their 1.x endpoints, pointing at that URL (ADR 0005, section 7). The
   sunset comes no earlier than six months after 2.0.0.

## Maintainer secrets

| Secret | Used by |
|--------|---------|
| `DOCKERHUB_TOKEN` | Docker Hub publish for `theosfactory/har-control` (PAT with read/write on the repo) |
| `GITHUB_TOKEN` | GitHub Release (provided by Actions) |

npm needs no secret: `publish-npm` uses Trusted Publishing (see above).

Dry-run the next release from the Actions tab (**Release → Run workflow → Dry run**) or locally:

```bash
npm ci
GITHUB_TOKEN=... npx semantic-release --dry-run
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
