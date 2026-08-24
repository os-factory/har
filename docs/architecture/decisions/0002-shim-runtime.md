# ADR 0002: Raw-script surface as an interface over the canonical core

- Status: Accepted
- Date: 2026-08-24
- Extends: [ADR 0001](./0001-work-identity.md) (HAR owns execution and proof)
- Supersedes: the pre-1.0 stance that `.har/` shell scripts *are* the runtime
  ("checked-in scripts are the runtime contract; put behavior directly in the
  harness scripts")

## Context

Before 1.0, `har env init` vendored HAR's runtime into every repository:
~20 files and ~8,800 lines of shell, forked three ways across profiles, with
port allocation, preflight, and slot-registry logic implemented in both bash
and TypeScript. This produced:

- **Behavioral drift between surfaces** — raw `./.har/*.sh` runs never wrote
  run or validation records, so evidence (ADR 0001's core concern) depended on
  which entry point an agent happened to use.
- **Untrackable adaptation** — project customization and HAR machinery lived
  in the same files, so drift detection could not tell an intentional
  adaptation from a stale fork, and upgrades required merging machinery
  changes through user-edited scripts.
- **Duplication** — ~2,400 byte-identical lines across the three boilerplates.

The original rationale for vendored scripts — reviewable, versioned,
usable without HAR — applied to the *project's behavior*, but in practice
75–80% of the vendored lines were machinery no project ever meant to own.

## Decision

The harness runtime lives **once**, in the npm package. The checked-in
`./.har/*.sh` files remain — but as a thin, stable **interface** over that
canonical core: each shim resolves the runtime (`har` on PATH → repo-local
`node_modules/.bin/har` → `npx @osfactory/har@<pinned>`) and forwards its
argument conventions unchanged.

`.har/` becomes a **configuration surface** holding only what the project
owns: schema-validated config (`harness.env`), verification as data
(`stages.json` + `.har/stages/`), lifecycle hooks (`.har/hooks/`), local
plugins (`.har/plugins/`), and adapted docs.

Two escape valves keep the old promise of full ownership honest:

- `har env eject` vendors the runtime bundle explicitly and rewires the
  scripts to run it directly — ownership as a recorded decision, not a
  silently degraded fork.
- The shim argument conventions (`./.har/launch.sh 1`,
  `./.har/verify.sh 1 --full`, `./.har/teardown.sh 1`) are a compatibility
  contract and do not break.

## Consequences

- Every surface — shell, CLI, MCP — runs the same code and writes the same
  run records, validations, and telemetry, closing the evidence gap with
  ADR 0001.
- Drift becomes two-signal (user-edited vs upstream-updated): adaptation is
  tracked config, not a diff against machinery.
- Repositories without `har` installed still work through the pinned npx
  fallback (or an ejected runtime, offline).
- HAR upgrades change one package instead of merging into vendored scripts;
  pre-1.0 harnesses migrate via a versioned, `maintain`-driven flow.
- The reviewability argument survives in sharper form: what is checked in is
  exactly what the team decided, and nothing else.
