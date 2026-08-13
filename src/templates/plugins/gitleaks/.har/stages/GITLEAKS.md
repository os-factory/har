# Gitleaks secrets scan — authoring & adaptation guide

The `secrets-scan` stage runs [Gitleaks](https://github.com/gitleaks/gitleaks)
against the agent's work dir and fails when hardcoded secrets are found. It is a
**pre-merge, shift-left** check: it catches credentials before they ever reach the
default branch.

## Prerequisite

The `gitleaks` binary must be on PATH:

```bash
brew install gitleaks                 # macOS / Linuxbrew
# or download a release binary:
#   https://github.com/gitleaks/gitleaks/releases
```

The stage fails fast with an install hint when the binary is missing.

## Running

```bash
./.har/stages/secrets-scan.sh <agent-id>        # dir mode (default)
./.har/stages/secrets-scan.sh <agent-id> git    # history mode
```

| Mode | What it scans | Use when |
|---|---|---|
| `dir` (default) | Every file currently in the work dir, **including uncommitted changes** | Normal verification — agents usually have uncommitted edits |
| `git` | The full git history of the worktree | Auditing that a secret never entered history (e.g. committed then removed) |

`git` mode on a repository with pre-existing leaks in old commits will fail on
findings unrelated to the current session. Generate a
[baseline](https://github.com/gitleaks/gitleaks#baseline) once and ignore known
history, or stick to `dir` mode for per-session verification.

## Artifacts

Written to the **main repo root**, not the worktree:

| Path | Content |
|---|---|
| `.har/artifacts/secrets-scan/report.json` | JSON findings (rule, file, line — secret values are **redacted** via `--redact`) |
| `.har/artifacts/secrets-scan/gitleaks.log` | Full scanner output for debugging |

The stage prints a JSON summary to stdout: `status`, `leaks_found`, and the first
20 findings. Exit code 0 = clean, 1 = leaks found, anything else = scanner error.

## Tuning what gets flagged

The plugin ships a root `.gitleaks.toml` that extends the default ruleset and
allowlists dependency/build directories (`node_modules`, `dist`, `build`,
`vendor`, `.git`, `.har/artifacts`). Adapt it per repo:

- **False positive in a specific line** — append `# gitleaks:allow` to that line.
- **Test fixtures with dummy keys** — add the path to `[allowlist] paths` in
  `.gitleaks.toml` (entries are regexes).
- **Custom internal token formats** — add `[[rules]]` entries; the shipped config
  keeps `useDefault = true`, so default rules stay active.

Gitleaks automatically picks up `.gitleaks.toml` at the scan target root, so the
same config governs local stage runs and CI.

## CI and compliance platforms (Vanta, Drata, …)

The optional workflow `.github/workflows/gitleaks.yml` (skipped with `--skip-ci`)
runs the official [`gitleaks/gitleaks-action`](https://github.com/gitleaks/gitleaks-action)
on pushes and pull requests.

Note the split: **this stage's local runs produce no compliance evidence** — they
exist so secrets never land on the default branch. Compliance platforms such as
Vanta ingest evidence from org-level sources (your GitHub organization, code
scanning results, etc.), which the CI workflow feeds. Keep both: the local stage
prevents findings; the CI run proves scanning happens.

Organizations (not personal accounts) need a free `GITLEAKS_LICENSE` secret for
the action — see the workflow comments.
