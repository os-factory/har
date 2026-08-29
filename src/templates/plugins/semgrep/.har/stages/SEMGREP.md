# Semgrep SAST Stage

The `sast` stage scans the agent's session worktree with [Semgrep](https://semgrep.dev)
and fails verification when blocking findings exist. Full verify (`verify --full`)
runs it automatically once it is listed in `verificationStages`.

## Running

```bash
# Whole worktree
./.har/stages/sast.sh 1

# Only specific paths
./.har/stages/sast.sh 1 src/ lib/auth.py

# Included in full verify
har env verify 1 --full
```

Reports land under `.har/artifacts/sast/` in the **main repo root** (not the worktree):

| File | Contents |
|------|----------|
| `semgrep.json` | Full findings report (machine-readable) |
| `semgrep.sarif` | SARIF report — upload to GitHub code scanning if desired |
| `scan.log` | Semgrep's own text output for the run |

Exit codes pass through from Semgrep: `0` clean, `1` findings, `>=2` scan error.

## Choosing rules

The stage runs `semgrep scan --config "$HARNESS_SEMGREP_CONFIG"` (default `auto`).
Set the variable in `.har/harness.env` to pin behavior:

```bash
# .har/harness.env
export HARNESS_SEMGREP_CONFIG="p/ci"          # curated low-noise ruleset
# export HARNESS_SEMGREP_CONFIG="p/security-audit"
# export HARNESS_SEMGREP_CONFIG=".semgrep/"   # local rules only (works offline)
```

Honest notes about `--config auto` and registry rulesets (`p/...`):

- They **fetch rules from the Semgrep registry**, so the stage needs network access.
- Semgrep **sends pseudonymized metrics** to semgrep.dev when registry configs are
  used (this cannot be disabled for registry configs). For fully offline, metric-free
  scans, commit local rule files and point `HARNESS_SEMGREP_CONFIG` at them.
- `auto` picks rulesets based on the languages it detects — convenient, but pin a
  named ruleset (`p/ci`) when you want reproducible results.

## Tuning noise

- Semgrep respects `.gitignore` by default; add a [`.semgrepignore`](https://semgrep.dev/docs/ignoring-files-folders-code)
  file for extra exclusions (vendored code, generated files, fixtures).
- The stage always passes `--exclude .har` — harness scaffolding is not your
  project's code and semgrep cannot parse some of its bash.
- Suppress a single finding with a trailing `# nosemgrep: <rule-id>` comment —
  prefer rule-scoped suppressions over blanket `# nosemgrep`.
- Write repo-specific rules under `.semgrep/` and add the directory to your config.

## CI and compliance (Vanta)

Of the security plugins, this one has the strongest compliance story. The optional
workflow `.github/workflows/semgrep.yml` runs `semgrep ci` in the official
`semgrep/semgrep` container. With a `SEMGREP_APP_TOKEN` secret (generated in
Semgrep AppSec Platform → Settings), findings publish to the
[Semgrep AppSec Platform](https://semgrep.dev/login) — which has a
[native Vanta integration](https://help.vanta.com/en/articles/15705377-connecting-vanta-semgrep):
Vanta pulls findings, projects, and scan history from Semgrep automatically as
compliance evidence.

Division of labor:

- **This local stage** is the shift-left layer — agents catch findings *before*
  code lands on the default branch. Local runs are invisible to Vanta (no noise).
- **The CI run** (`semgrep ci` on the default branch and PRs) is the org-level
  evidence layer Vanta reads.

Without a token, the workflow falls back to `semgrep scan --config auto --error`
(Community Edition — CI still blocks on findings, but nothing publishes to the
platform and there is no Vanta evidence).

## Adapting per repo

- Pin `HARNESS_SEMGREP_CONFIG` to the ruleset your team standardizes on.
- Add `.semgrepignore` entries for paths that produce noise.
- If findings should not block agents yet, keep `sast` out of `verificationStages`
  in `.har/stages.json` and run it manually while you triage the baseline.
- The stage summarizes reports with `node`; it assumes a Node.js toolchain is
  available (true for HAR-provisioned slots on node ecosystems — on other stacks,
  ensure `node` is on PATH or adapt the summary block).
