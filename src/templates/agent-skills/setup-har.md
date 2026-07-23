# Set up the har harness in this repository

You are onboarding this repository onto har (an agent-harness orchestrator). Do every step yourself — do not ask the user to paste prompts or run commands unless a step needs their approval.

## 1. Ensure the har CLI is installed

```bash
har --version
```

If missing, install it and re-check:

```bash
npm install -g @osfactory/har
```

## 2. Pick a harness profile

Inspect the repository and choose the profile that matches how agents will run it:

| Profile | Use when |
|---------|----------|
| `default` | Web app / server with a long-running process (Next.js, Rails, Django, APIs) |
| `cli` | CLI tool, library, or npm package — no dev server to keep alive |
| `ios` | iOS / Swift app built with xcodebuild + Simulator |

Tell the user which profile you picked and why before continuing.

## 3. Initialize the harness

```bash
har env init --profile <profile>   # omit --profile for default
```

If `.har/` already exists, stop and suggest `/har-maintain` instead.

## 4. Perform the adaptation yourself

`har env init` prints an adaptation prompt and writes it to `.har/ADAPT-PROMPT.md`. Read that file and **execute its instructions yourself, now, in this session** — tailor `.har/` scripts (`launch.sh`, `verify.sh`, `setup-infra.sh`, `harness.env`, `stages.json`) and `AGENT.md` to this repository's real stack, ports, and commands. Do not use `--auto` and do not ask the user to paste anything.

## 5. Register the project's checks as stages

Convert the repository's real check commands (test, lint, typecheck, whatever CI runs) into registered stages so they run in `verify --full` and are visible to every agent. Read `.har/STAGES.md` for the contract, then:

```bash
har env add-stage unit-tests --custom --kind test --command "npm test" --verification
```

- Use `--command` for one-liner checks; use `--script` when a check needs the slot's env, ports, or artifacts (then implement the scaffolded `.har/stages/<id>.sh`).
- Rich integrations ship as templates: `har env add-stage --list`, then e.g. `har env add-stage playwright` (web) or `har env add-stage rocketsim` (iOS).

## 6. Prove the harness works

```bash
har env launch 1
har env verify 1
```

Fix the harness scripts until both pass. Then tear down or keep the slot as the user prefers (`har env teardown 1` keeps the branch).

## 7. Commit

After the user confirms, commit the harness:

```bash
git add .har/ AGENT.md CLAUDE.md .claude/ .cursor/ 2>/dev/null || git add .har/ AGENT.md
git commit -m "chore: add har agent harness"
```

Init applies the user's `har preferences` commit-gate policy. Confirm with
`har hooks status`; recommend `har hooks install --claude` separately when the
Claude Code main-checkout worktree guard is useful.
