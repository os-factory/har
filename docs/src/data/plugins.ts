export interface PluginLink {
  label: string;
  href: string;
}

export interface PluginEntry {
  id: string;
  name: string;
  logo: string;
  category: string;
  stacks: string;
  stageId: string;
  tagline: string;
  seoTitle: string;
  seoDescription: string;
  /** The story: why this plugin exists and what it does for agent workflows. */
  intro: string[];
  /** What `har env add-plugin <id>` installs. */
  installs: string[];
  /** Logo is dark-stroke art that needs inverting on the dark theme. */
  invertOnDark?: boolean;
  /** External binaries / accounts needed beyond the plugin itself. */
  requirements: string[];
  /** Where reports land and what a run produces. */
  artifacts: string;
  /** Tuning and adaptation notes. */
  adaptation: string[];
  /** CI + compliance story (omitted when not relevant). */
  compliance?: string[];
  links: PluginLink[];
}

export const plugins: PluginEntry[] = [
  {
    id: 'playwright',
    name: 'Playwright',
    logo: '/assets/logo-playwright.svg',
    category: 'Browser e2e',
    stacks: 'Web apps',
    stageId: 'browser-e2e',
    tagline: 'Browser e2e verification with frontend, API health, and accessibility smoke specs.',
    seoTitle: 'Playwright plugin — browser e2e verification for coding agents | HAR',
    seoDescription:
      'Run Playwright end-to-end tests as a HAR verification stage. Coding agents prove their UI changes work in a real browser before code lands — per-slot ports, smoke specs, and CI included.',
    intro: [
      'Coding agents are good at editing components and terrible at noticing they broke the page. The Playwright plugin closes that gap: every agent session gets a browser-e2e stage that drives the app the agent just changed, in a real browser, against the slot’s own running instance.',
      'HAR gives each agent slot its own ports, so parallel agents each test their own copy of the app — no shared staging environment, no cross-agent interference. A change is only “done” when the browser agrees.',
    ],
    installs: [
      'A `browser-e2e` test stage registered in `.har/stages.json` and added to `verificationStages`, so `har env verify` runs it automatically.',
      'Playwright configuration wired to the slot’s computed BASE_URL and ports.',
      'Frontend, API health, and accessibility smoke specs as a starting point.',
      'Pinned `devDependencies` and npm scripts merged into `package.json`.',
      'A GitHub Actions workflow from the official Playwright recipe (skip with `--skip-ci`).',
    ],
    requirements: ['Node.js project (the plugin merges `package.json`)', 'Browsers via `npx playwright install`'],
    artifacts:
      'HTML reports, traces, and screenshots land under `.har/artifacts/browser-e2e/` in the main repo — inspectable evidence for every run, kept out of the worktree.',
    adaptation: [
      'The shipped specs are smoke-level on purpose: adapt selectors and URLs to your app after installation, then grow the suite where agents break things most.',
      'Full verification runs the stage whenever it is listed in `verificationStages` — the plugin updates that list for you.',
    ],
    links: [
      { label: 'Playwright docs', href: 'https://playwright.dev' },
      { label: 'Plugin install guide', href: '/docs/guides/plugins/#playwright' },
    ],
  },
  {
    id: 'rocketsim',
    name: 'RocketSim',
    logo: '/assets/logo-rocketsim.png',
    category: 'iOS simulator flows',
    stacks: 'iOS apps',
    stageId: 'rocketsim-flows',
    tagline: 'Scripted iOS Simulator flows so agents verify app behavior, not just compilation.',
    seoTitle: 'RocketSim plugin — iOS Simulator flow verification for coding agents | HAR',
    seoDescription:
      'Run RocketSim-driven iOS Simulator flows as a HAR verification stage. Coding agents working on Xcode and Swift projects prove their changes on a booted simulator before code lands.',
    intro: [
      'On iOS, “it compiles” is a long way from “it works.” The RocketSim plugin gives agent sessions a rocketsim-flows stage: scripted flows that exercise the app on a booted iOS Simulator, so an agent’s change is validated by the app actually behaving — deep links resolving, screens rendering, flows completing.',
      'It pairs naturally with HAR’s `ios` profile, which already drives `xcodebuild` and the Simulator per agent slot.',
    ],
    installs: [
      'A `rocketsim-flows` test stage registered in `.har/stages.json`.',
      'A flow runner plus authoring guidance for writing your own flows.',
      'An example smoke flow to copy from.',
    ],
    requirements: [
      'macOS with Xcode and a booted iOS Simulator',
      'RocketSim installed (external requirement — the stage fails fast with a hint when missing)',
    ],
    artifacts: 'Flow output and evidence land under `.har/artifacts/rocketsim-flows/` in the main repo.',
    adaptation: [
      'Flows live in your repo and travel with the change batch — agents adapt or extend them like any other test.',
      'See `.har/stages/ROCKETSIM.md` after install for flow authoring and per-repo adaptation.',
    ],
    links: [
      { label: 'RocketSim', href: 'https://www.rocketsim.app' },
      { label: 'Plugin install guide', href: '/docs/guides/plugins/#rocketsim' },
    ],
  },
  {
    id: 'kerno',
    name: 'Kerno',
    logo: '/assets/logo-kerno.svg',
    category: 'Backend validation',
    stacks: 'Backend services',
    stageId: 'backend-validation',
    tagline: 'Deterministic backend scenario re-runs with greybox database checks — no LLM in the loop.',
    seoTitle: 'Kerno plugin — deterministic backend validation for coding agents | HAR',
    seoDescription:
      'Re-run your committed Kerno scenario suite against each agent slot as a HAR verification stage. Deterministic pass/fail with greybox database checks and a full evidence trail.',
    intro: [
      'Backend changes fail in ways unit tests don’t see: a handler that returns 200 but writes the wrong row, a migration that silently breaks a flow. The Kerno plugin adds a backend-validation stage that re-runs your committed Kerno scenario suite (`.kerno/scenarios/`) against the app running in the agent’s slot — deterministically, with no LLM in the loop.',
      'Scenarios use the slot’s own database for greybox checks and report pass/fail with a full evidence trail, so an agent’s backend change is proven against real requests and real state.',
    ],
    installs: [
      'A `backend-validation` test stage registered in `.har/stages.json`.',
      'A fail-fast lock that serializes backend validation across slots (Kerno runs one agent per machine); frontend stages still run concurrently.',
      'An adaptation guide at `.har/stages/KERNO.md`.',
    ],
    requirements: [
      'Kerno CLI (`npm install -g @kerno/cli`) and Docker',
      'A Kerno agent bound to the slot’s worktree (`kerno init`)',
      'A committed scenario suite — validation re-runs an existing suite, it does not generate one',
    ],
    artifacts: 'Scenario results and the evidence trail land under `.har/artifacts/backend-validation/`.',
    adaptation: [
      'The stage never starts or rebinds the Kerno agent — binding is a one-time setup per machine.',
      'See `.har/stages/KERNO.md` for the full setup and adaptation guide.',
    ],
    links: [
      { label: 'Kerno', href: 'https://kerno.io' },
      { label: 'Plugin install guide', href: '/docs/guides/plugins/#kerno' },
    ],
  },
  {
    id: 'gitleaks',
    name: 'Gitleaks',
    logo: '/assets/logo-gitleaks.png',
    invertOnDark: true,
    category: 'Secrets scanning',
    stacks: 'Any stack',
    stageId: 'secrets-scan',
    tagline: 'Catch leaked credentials in agent worktrees before they ever reach a branch.',
    seoTitle: 'Gitleaks plugin — pre-merge secrets scanning for coding agents | HAR',
    seoDescription:
      'Run Gitleaks as a HAR verification stage. Every agent session scans its worktree — uncommitted changes included — so hardcoded keys and tokens are caught before code lands. Redacted reports, CI workflow included.',
    intro: [
      'A secret that reaches your default branch is an incident even after you revert it. Coding agents make this failure mode more likely, not less: they paste example keys, wire up services with inline tokens, and commit fast. The Gitleaks plugin makes every agent session scan its own worktree — uncommitted changes included — before work is called done.',
      'The stage runs Gitleaks in directory mode by default, precisely because agents usually have uncommitted edits at verification time that git-history scanners never see. Pass `git` as the second stage argument to audit full history instead.',
    ],
    installs: [
      'A `secrets-scan` test stage registered in `.har/stages.json` and added to `verificationStages`.',
      'A root `.gitleaks.toml` extending the default ruleset with harness allowlists (skipped if your repo already has one).',
      'A GitHub Actions workflow using the official `gitleaks/gitleaks-action` (skip with `--skip-ci`).',
    ],
    requirements: [
      'The `gitleaks` binary (`brew install gitleaks` or a release binary) — the stage fails fast with an install hint when missing',
    ],
    artifacts:
      'JSON reports land under `.har/artifacts/secrets-scan/` with secret values redacted — evidence of the finding, never a second copy of the secret.',
    adaptation: [
      'Tune allowlists in `.gitleaks.toml` for fixtures and test keys; see `.har/stages/GITLEAKS.md` after install for allowlist and baseline guidance.',
      'The stage exits distinctly for “leaks found” vs “tool error,” so a broken install never masquerades as a clean scan.',
    ],
    compliance: [
      'The local stage is your shift-left layer: it keeps secrets from ever reaching the default branch. The CI workflow is the org-level layer — it produces the scanning evidence that compliance platforms such as Vanta or Drata ingest via their GitHub integrations. Keep both: local runs protect the branch, CI runs prove it to auditors.',
    ],
    links: [
      { label: 'Gitleaks', href: 'https://github.com/gitleaks/gitleaks' },
      { label: 'Plugin install guide', href: '/docs/guides/plugins/#gitleaks' },
    ],
  },
  {
    id: 'trivy',
    name: 'Trivy',
    logo: '/assets/logo-trivy.png',
    category: 'Vulnerabilities & IaC',
    stacks: 'Any stack',
    stageId: 'vuln-scan',
    tagline: 'Dependency CVEs and Terraform, Docker, and Kubernetes misconfigurations, caught pre-merge.',
    seoTitle: 'Trivy plugin — dependency and IaC scanning for coding agents | HAR',
    seoDescription:
      'Run Trivy as a HAR verification stage. Agent sessions scan lockfiles for known CVEs and Terraform, Dockerfiles, and Kubernetes manifests for misconfigurations before code lands. SARIF upload to GitHub code scanning included.',
    intro: [
      'Agents add dependencies and edit infrastructure files without a security reviewer looking over their shoulder. The Trivy plugin gives every session a vuln-scan stage: one scan of the agent’s worktree that covers known CVEs in dependency lockfiles and misconfigurations in Terraform, Dockerfiles, Kubernetes manifests, and other IaC.',
      'Trivy absorbed tfsec, so Terraform checks are included — one binary and one stage cover what used to take three tools.',
    ],
    installs: [
      'A `vuln-scan` test stage registered in `.har/stages.json` and added to `verificationStages`.',
      'A `.trivyignore` scaffold for documented suppressions that travel with the change batch.',
      'A GitHub Actions workflow that uploads SARIF to GitHub code scanning (skip with `--skip-ci`).',
    ],
    requirements: [
      'The `trivy` binary (`brew install trivy`) — the stage fails fast with an install hint when missing',
    ],
    artifacts:
      'JSON reports and a readable summary land under `.har/artifacts/vuln-scan/`. The vulnerability database is cached once per machine (`TRIVY_CACHE_DIR`), so repeat runs finish in about a second.',
    adaptation: [
      'The fail threshold defaults to `HIGH,CRITICAL` — tune `HARNESS_TRIVY_SEVERITY` and `HARNESS_TRIVY_SCANNERS` in `.har/harness.env`.',
      'See `.har/stages/TRIVY.md` for container image scanning and monorepo scoping.',
    ],
    compliance: [
      'The local stage is pre-merge shift-left; the CI workflow feeds GitHub code scanning — the org-level evidence layer that compliance platforms such as Vanta ingest. Keep both: fewer findings ever reach the layer your auditors watch.',
    ],
    links: [
      { label: 'Trivy', href: 'https://trivy.dev' },
      { label: 'Plugin install guide', href: '/docs/guides/plugins/#trivy' },
    ],
  },
  {
    id: 'semgrep',
    name: 'Semgrep',
    logo: '/assets/logo-semgrep.svg',
    category: 'Static analysis (SAST)',
    stacks: 'Any stack',
    stageId: 'sast',
    tagline: 'Static analysis on every agent worktree, with a native path to compliance evidence.',
    seoTitle: 'Semgrep plugin — pre-merge SAST for coding agents | HAR',
    seoDescription:
      'Run Semgrep static analysis as a HAR verification stage. Agent sessions scan their worktree for injection bugs and insecure patterns before code lands, with JSON and SARIF reports — and a CI path to the Semgrep AppSec Platform and its native Vanta integration.',
    intro: [
      'Agents write plausible code, and plausible code is where injection bugs live: a `shell=True` here, string-built SQL there. The Semgrep plugin adds a sast stage that scans the session worktree with Semgrep’s rulesets, so insecure patterns block the agent before merge instead of surfacing in review — or production.',
      'Findings fail the stage with the exact rule and location in the report, which is precisely the feedback loop agents fix fastest.',
    ],
    installs: [
      'A `sast` test stage registered in `.har/stages.json` and added to `verificationStages`.',
      'An adaptation guide at `.har/stages/SEMGREP.md` covering rulesets and noise tuning.',
      'A GitHub Actions workflow running the official `semgrep ci` recipe (skip with `--skip-ci`).',
    ],
    requirements: [
      'The `semgrep` CLI (`pipx install semgrep`) — the stage fails fast with an install hint when missing',
      'Registry rulesets (the default `auto`) need network access; offline repos can pin local rules',
    ],
    artifacts: 'JSON and SARIF reports land under `.har/artifacts/sast/`, alongside the scan log.',
    adaptation: [
      'Pin rulesets with `HARNESS_SEMGREP_CONFIG` in `.har/harness.env` (default `auto`).',
      'Tune noise with `.semgrepignore` and `nosemgrep` annotations — guidance ships in `.har/stages/SEMGREP.md`.',
    ],
    compliance: [
      'This plugin has the strongest compliance story of the security set. The local stage is the shift-left layer — findings block agents before merge, invisible to compliance platforms by design. For evidence, set the `SEMGREP_APP_TOKEN` secret so the CI workflow publishes to the Semgrep AppSec Platform, which Vanta reads through its native Semgrep integration.',
    ],
    links: [
      { label: 'Semgrep', href: 'https://semgrep.dev' },
      { label: 'Vanta × Semgrep integration', href: 'https://help.vanta.com/en/articles/15705377-connecting-vanta-semgrep' },
      { label: 'Plugin install guide', href: '/docs/guides/plugins/#semgrep' },
    ],
  },
];
