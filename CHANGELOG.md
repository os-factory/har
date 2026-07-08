# [0.4.0](https://github.com/os-factory/har/compare/v0.3.0...v0.4.0) (2026-07-08)


### Features

* **benchmark:** swebench har benchmark ([#26](https://github.com/os-factory/har/issues/26)) ([e779ebf](https://github.com/os-factory/har/commit/e779ebf9518f0be1529bad918ad6faa8a37d53fd)), closes [19-#25](https://github.com/19-/issues/25)

# [0.3.0](https://github.com/os-factory/har/compare/v0.2.0...v0.3.0) (2026-07-08)


### Features

* **harness:** improve slot resilience and readiness guidance ([#17](https://github.com/os-factory/har/issues/17)) ([d99f0bb](https://github.com/os-factory/har/commit/d99f0bb205cd7fefda86ae9e3122549df0bf24ed))

# [0.2.0](https://github.com/os-factory/har/compare/v0.1.0...v0.2.0) (2026-07-07)


### Bug Fixes

* **ci:** allow release commit ([608dc63](https://github.com/os-factory/har/commit/608dc63370f517b4c481f1c21ec4718561976346))
* **ci:** protect deployment ([791b17e](https://github.com/os-factory/har/commit/791b17eeb01ef1d55a73f8febe40a1a684961024))
* **ci:** remove duplicates CI run tests ([5299d00](https://github.com/os-factory/har/commit/5299d000684374ee1e7215273a689a6d7fd1c34e))
* **ci:** remove permissions of issues ([6be6604](https://github.com/os-factory/har/commit/6be66044e1f116f212c8b50fa0e9e472a59ad22d))
* **ci:** update repo url and fix tests ([c430136](https://github.com/os-factory/har/commit/c430136f53c082398b2f5574181a8af2a289ce07))
* **ci:** use the right secrets ([3199433](https://github.com/os-factory/har/commit/3199433fa27cab28f44c3479f19a3a753c796722))
* **verify:** keep failed steps when output exceeds 50 lines ([#16](https://github.com/os-factory/har/issues/16)) ([39757c9](https://github.com/os-factory/har/commit/39757c990deb54ec51f044d5d20df792196899b9))
* **verify:** use portable millisecond clock on macOS/BSD ([#15](https://github.com/os-factory/har/issues/15)) ([1864a92](https://github.com/os-factory/har/commit/1864a92714a8be80ef7706b40a3ce5b101b6ae82))


### Features

* bump version to 0.1.1 ([d518964](https://github.com/os-factory/har/commit/d518964e46ee2e439404bdbdef90a787e40b3e2a))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release process

Only **`@osfactory/har`** is published to npm. `@har/control` and `@har/schemas` stay
private in the monorepo and ship with the repo / Docker image instead.

Releases are cut automatically when conventional commits merge to `main`. The
[Release workflow](.github/workflows/release.yml) verifies, publishes `@osfactory/har`
to npm, creates the GitHub Release + tag, and pushes `theosfactory/har-control`
(semver tags plus `latest`) in one pipeline. See
[CONTRIBUTING.md](./CONTRIBUTING.md#releases) for maintainer setup.

### Semver policy

| Bump | When | Examples |
|------|------|----------|
| **Patch** | Bug fixes, template tweaks, docs that affect bundled harness files | `fix: correct verify.sh exit code parsing`, `fix: update har-boilerplate launch.sh` |
| **Minor** | New CLI flags, MCP tools, backward-compatible features | `feat: add har env runs export`, `feat(mcp): expose har_list_stages` |
| **Major** | Breaking harness contract, CLI API, or run-record format changes | `feat!: rename stage kinds in stages.json`, `BREAKING CHANGE: drop run JSON v1` |

Commit prefixes map to bumps via [Conventional Commits](https://www.conventionalcommits.org/)
(`fix:` → patch, `feat:` → minor, `feat!:` / `BREAKING CHANGE:` → major).

## [Unreleased]

### Changed

- Public license is **AGPL-3.0-only** with dual-licensing docs (CLA, commercial license, trademark policy)
- GitHub home moved to [antoineFrau/har](https://github.com/antoineFrau/har)

## [0.1.0] - 2026-07-02

First public npm release of `@osfactory/har`.

### Added

- `har env` commands: init, maintain, launch, verify, status, teardown, add-stage
- `har control` commands for local Mission Control (Docker Compose)
- HAR MCP server (`har mcp`) with generic stage and run-history tools
- Bundled `.har/` harness templates (web app and CLI profiles)
- Optional Playwright stage template (`har env add-stage playwright`)
- Run history under `.har/runs/` when using CLI or MCP (not raw shell scripts)

[Unreleased]: https://github.com/antoineFrau/har/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/antoineFrau/har/releases/tag/v0.1.0
