# Trivy Vulnerability & Misconfiguration Scanning

The `vuln-scan` stage runs [Trivy](https://trivy.dev) against the agent's
worktree: known CVEs in dependency lockfiles (`vuln` scanner) and IaC/config
misconfigurations in Terraform, Dockerfiles, Kubernetes manifests, Helm charts,
and CloudFormation (`misconfig` scanner). Full verify (`verify --full`) runs it
automatically.

Trivy absorbed **tfsec** — its Terraform checks now live in Trivy's `misconfig`
scanner, so this plugin covers the Terraform/IaC use case without a separate tool.

## What runs

```bash
trivy fs --scanners vuln,misconfig --severity HIGH,CRITICAL --exit-code 1 \
  --format json --output .har/artifacts/vuln-scan/report.json <work-dir>
```

The stage **fails** when any finding at or above the severity threshold exists.
Findings below the threshold are not reported at all — raise or lower the bar
via configuration.

## Configuration

Set in `harness.env` (or export before running):

| Variable | Default | Purpose |
|----------|---------|---------|
| `HARNESS_TRIVY_SEVERITY` | `HIGH,CRITICAL` | Comma-separated severities that fail the stage (`UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL`) |
| `HARNESS_TRIVY_SCANNERS` | `vuln,misconfig` | Scanners to run (`vuln`, `misconfig`, `secret`, `license`) |
| `TRIVY_CACHE_DIR` | `~/.cache/trivy` | Vulnerability DB cache — kept **outside** the worktrees so every slot shares one DB download (~60MB, refreshed every ~6h) |

## Artifacts

| Path | Contents |
|------|----------|
| `.har/artifacts/vuln-scan/report.json` | Full Trivy JSON report (machine-readable) |
| `.har/artifacts/vuln-scan/summary.txt` | Human-readable table (`trivy convert`) |

Artifacts always land in the **main repo root** `.har/artifacts/`, not the worktree.

## Suppressing findings

Add IDs to `.trivyignore` at the repo root — one CVE / check ID per line, no
trailing comments on the ID line:

```
# Accepted risk: dev-only dependency, fix tracked in TICKET-123 (expires when bumped)
CVE-2021-23337
# Terraform check that conflicts with our architecture
AVD-AWS-0086
```

The stage passes the **worktree's** copy via `--ignorefile`, so a suppression
travels with the change batch that introduces it and gets reviewed in the same
PR. Prefer fixing (bump the dependency, correct the config) over ignoring.

## Adaptations per repo

- **Container images**: the default stage scans the filesystem only. If the repo
  builds an image, add a second invocation after the build:
  `trivy image --severity "$SEVERITY" --exit-code 1 <image:tag>`.
- **Monorepos**: scope the scan by replacing `"$WORK_DIR"` with a subdirectory,
  or add `--skip-dirs 'vendor/**,examples/**'`.
- **Lockfile-only scanning**: Trivy reads lockfiles (`package-lock.json`,
  `yarn.lock`, `poetry.lock`, `go.sum`, `Cargo.lock`, …). Repos without a
  lockfile get no dependency findings — commit one for meaningful results.
- **Secrets**: this harness pairs well with a dedicated secrets stage
  (gitleaks plugin, which scans git history, not just the checkout). Add
  `secret` to `HARNESS_TRIVY_SCANNERS` only if you don't run one.

## CI and compliance platforms (Vanta, Drata, …)

The local stage is **pre-merge shift-left** — it keeps findings from ever
reaching your default branch. Compliance platforms never see local runs.

The optional workflow `.github/workflows/trivy.yml` runs the same scan in CI and
uploads SARIF to **GitHub code scanning** (the repo's Security tab). That
org-level layer is what compliance platforms like Vanta ingest as evidence (via
their GitHub integration). Keep both: local stage to catch early, CI workflow to
produce the evidence.

## Running

```bash
./.har/stages/vuln-scan.sh 1        # standalone
./.har/verify.sh 1 --full           # as part of full verification
```
