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

## 2. Check Docker

Docker is required: Mission Control runs as a container and harness infrastructure
(databases, queues, browsers) starts through Docker Compose.

```bash
docker info
```

If the command fails, tell the user Docker must be installed and running
(https://docs.docker.com/get-started/get-docker/). You can still scaffold the
harness, but say clearly that Mission Control and containerized infra stay
unavailable until Docker works.

## 3. Pick a harness profile

Inspect the repository and choose the profile that matches how agents will run it:

| Profile | Use when |
|---------|----------|
| `default` | Web app / server with a long-running process (Next.js, Rails, Django, APIs) |
| `cli` | CLI tool, library, or npm package — no dev server to keep alive |
| `ios` | iOS / Swift app built with xcodebuild + Simulator |

Tell the user which profile you picked and why before continuing.

## 4. Initialize the harness

```bash
har env init --profile <profile>   # omit --profile for default
```

If `.har/` already exists, stop and suggest `/har-maintain` instead.

## 5. Perform the adaptation yourself

`har env init` prints an adaptation prompt and writes it to `.har/ADAPT-PROMPT.md`. Read that file and **execute its instructions yourself, now, in this session** — tailor the harness configuration surface (`harness.env`, `stages.json` + `.har/stages/`, `.har/hooks/`, `docker-compose.agent.yml`, `env.template`) and `AGENTS.md` to this repository's real stack, ports, and commands. The `./.har/*.sh` files are generated shims over the packaged runtime — never edit them.

## 6. Register the project's checks as stages

Convert the repository's real check commands (test, lint, typecheck, whatever CI runs) into registered stages so they run in `verify --full` and are visible to every agent. Read `.har/STAGES.md` for the contract, then:

```json
{ "id": "unit-tests", "kind": "test", "command": "npm test", "tier": "quick" }
```

(add the entry to `.har/stages.json` `stages` and its id to `verificationStages`).

- Use a command stage for one-liner checks; when a check needs the slot's env, ports, or artifacts, scaffold a project-owned plugin: `har plugin create <id>`, implement `.har/plugins/<id>/stages/<id>.sh`, then `har env add-plugin <id>`.
- Rich integrations ship as **plugins**: `har env add-plugin --list`, then e.g. `har env add-plugin playwright` (web) or `har env add-plugin rocketsim` (iOS). Plugins install stages; agents only talk to the stage registry.

## 7. Prove the harness works

```bash
har env launch 1
har env verify 1
```

Fix the harness scripts until both pass. Then tear down or keep the slot as the user prefers (`har env teardown 1` keeps the branch).

## 8. Commit

After the user confirms, commit the harness:

```bash
git add .har/ AGENTS.md CLAUDE.md .claude/ .cursor/ 2>/dev/null || git add .har/ AGENTS.md
git commit -m "chore: add har agent harness"
```

Init applies the user's `har preferences` commit-gate policy. Confirm with
`har hooks status`; recommend `har hooks install --claude` separately when the
Claude Code main-checkout worktree guard is useful.
