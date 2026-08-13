# Trivy plugin

Installs a `vuln-scan` stage that runs [Trivy](https://trivy.dev) against the
agent's worktree:

- **Dependency vulnerabilities** — known CVEs in lockfiles (`package-lock.json`,
  `yarn.lock`, `poetry.lock`, `go.sum`, `Cargo.lock`, …)
- **IaC misconfigurations** — Terraform, Dockerfile, Kubernetes, Helm,
  CloudFormation (Trivy absorbed tfsec, so this covers the Terraform use case)

```bash
har env add-plugin trivy            # --skip-ci to omit the GitHub workflow
```

What it adds:

- `.har/stages/vuln-scan.sh` — the stage, registered in `.har/stages.json` and
  appended to `verificationStages` (runs on `verify --full`)
- `.har/stages/TRIVY.md` — adaptation guide (severity threshold, scanners,
  container-image scanning, monorepo scoping)
- `.trivyignore` — suppression file scaffold
- `.github/workflows/trivy.yml` *(optional)* — same scan in CI with SARIF upload
  to GitHub code scanning; that org-level layer is what compliance platforms
  like Vanta ingest as evidence

External requirement: the `trivy` binary (`brew install trivy` or the
[install script](https://trivy.dev/latest/getting-started/installation/)).
The stage fails fast with an install hint when it is missing.

Fail threshold defaults to `HIGH,CRITICAL` — override with
`HARNESS_TRIVY_SEVERITY` in `.har/harness.env`. Reports land in
`.har/artifacts/vuln-scan/`.
