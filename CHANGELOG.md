# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Release process

Only **`@har/cli`** is published to npm. `@har/control` and `@har/schemas` stay
private in the monorepo and ship with the repo / Docker image instead.

Releases are cut automatically when conventional commits merge to `main`. The
[Release workflow](.github/workflows/release.yml) publishes `@har/cli`, opens a
GitHub Release, and triggers the Mission Control Docker publish. See
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

## [0.1.0] - 2026-07-02

First public npm release of `@har/cli`.

### Added

- `har env` commands: init, maintain, launch, verify, status, teardown, add-stage
- `har control` commands for local Mission Control (Docker Compose)
- HAR MCP server (`har mcp`) with generic stage and run-history tools
- Bundled `.har/` harness templates (web app and CLI profiles)
- Optional Playwright stage template (`har env add-stage playwright`)
- Run history under `.har/runs/` when using CLI or MCP (not raw shell scripts)

[Unreleased]: https://github.com/os-factory/har/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/os-factory/har/releases/tag/v0.1.0
