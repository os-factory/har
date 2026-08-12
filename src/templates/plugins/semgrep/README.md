# Semgrep plugin

Add a Semgrep SAST stage to your harness so agents catch security findings
before code lands.

```bash
har env add-plugin semgrep
```

## What this installs

| File | Purpose |
|------|---------|
| `.har/stages/sast.sh` | Stage runner — scans the session worktree with Semgrep |
| `.har/stages/SEMGREP.md` | Adaptation guide: rulesets, noise tuning, CI/Vanta story |
| `.github/workflows/semgrep.yml` | Optional CI workflow (`--skip-ci` to omit) — official `semgrep ci` recipe |

## Workflow

```
        Code change
             │
       launch slot
             │
   typecheck + unit-tests
             │
           sast  ◄── semgrep scan over the worktree
             │
          pass/fail
```

Full verify (`verify --full`) runs the scan after lint. Reports (JSON + SARIF)
land under `.har/artifacts/sast/`.

## Requirements

- `semgrep` CLI: `pipx install semgrep` (recommended), `pip install semgrep`,
  or `brew install semgrep`
- Network access for registry rulesets (`auto`, `p/ci`, …) — or commit local
  rules and set `HARNESS_SEMGREP_CONFIG` to their path for offline scans

## Compliance (Vanta)

The local stage is shift-left only — compliance platforms never see it. The CI
workflow's `semgrep ci` run (with a `SEMGREP_APP_TOKEN` secret) publishes to the
Semgrep AppSec Platform, which Vanta ingests natively as vulnerability-management
evidence. See `.har/stages/SEMGREP.md` for the full story.

## Quick start after install

```bash
pipx install semgrep
./.har/launch.sh 1
./.har/stages/sast.sh 1
# reports: .har/artifacts/sast/semgrep.json (+ .sarif, scan.log)
./.har/verify.sh 1 --full
```
