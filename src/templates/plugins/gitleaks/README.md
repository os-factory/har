# Gitleaks plugin

Installs a `secrets-scan` stage that runs [Gitleaks](https://github.com/gitleaks/gitleaks)
against the agent work dir, so hardcoded credentials fail verification before
they reach the default branch.

```bash
har env add-plugin gitleaks
```

What it adds:

- `.har/stages/secrets-scan.sh` — the stage script (registered in `.har/stages.json`
  and appended to `verificationStages`)
- `.har/stages/GITLEAKS.md` — adaptation guide
- `.gitleaks.toml` — default config extending the built-in ruleset with harness
  allowlists (skipped if the repo already has one)
- `.github/workflows/gitleaks.yml` — official `gitleaks/gitleaks-action` CI
  workflow (opt in with `--with-ci`)

Requirements: the `gitleaks` binary on PATH (`brew install gitleaks` or a
[release binary](https://github.com/gitleaks/gitleaks/releases)). No package.json
changes — Gitleaks is an external tool, like RocketSim.

Run it:

```bash
./.har/stages/secrets-scan.sh 1        # scan the working tree (default)
./.har/stages/secrets-scan.sh 1 git    # scan full git history
```

Findings land in `.har/artifacts/secrets-scan/report.json` (secret values
redacted). See `.har/stages/GITLEAKS.md` for tuning allowlists, baselines for
noisy history, and how the CI workflow feeds compliance platforms like Vanta.
