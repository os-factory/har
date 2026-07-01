# HAR FAQ

## What Is HAR?

HAR is an open-source CLI and MCP harness/control plane for software repositories.

It helps a team turn repo-specific knowledge into an editable `.har/` contract that agents and humans can use to launch the app, run verification, reset state, inspect logs, collect artifacts, and know when work is ready for review.

HAR is not a coding LLM, a browser test runner, or a CI/CD replacement. It is the layer that tells any capable agent how to operate safely inside a real codebase.

## Basic Concepts

<details>
<summary><strong>Q: What is a harness?</strong></summary>

**A:** A harness is the project-owned operating manual plus scripts for a repo. It answers questions like:

- How do I install dependencies?
- How do I launch the app?
- How do I verify a change?
- How do I reset state?
- Where are logs, preview URLs, and artifacts?
- Which commands are safe for agents to run?

HAR keeps that knowledge in `.har/` so it can be versioned, reviewed, customized, and used by both humans and agents.

</details>

<details>
<summary><strong>Q: Why not let agents figure this out themselves?</strong></summary>

**A:** Agents can infer a lot, but repo setup is full of local conventions, hidden dependencies, ports, databases, secrets, test commands, and cleanup steps. A harness removes guesswork.

Instead of every agent rediscovering how the repo works, HAR gives agents a stable contract: describe the project, launch an environment, run a stage, inspect the result, and clean up.

</details>

<details>
<summary><strong>Q: Is HAR tied to Cursor, Claude Code, Codex, or another agent?</strong></summary>

**A:** No. HAR should be agent-agnostic.

The OSS core is a CLI plus MCP adapter. Any MCP-capable agent can use the HAR server, and humans can still run the `.har/` scripts or `har env ...` commands directly.

</details>

<details>
<summary><strong>Q: Does HAR replace CI/CD?</strong></summary>

**A:** No. CI/CD remains the source of truth for merges, releases, and deployments.

HAR gives agents and developers a local or self-hosted harness that mirrors the important parts of the workflow earlier in the development loop. The goal is to catch issues before CI and make agent work easier to inspect.

</details>

## OSS Core

<details>
<summary><strong>Q: What is included in the open-source HAR core?</strong></summary>

**A:** The open-source product should include:

- The `har` CLI
- Editable `.har/` boilerplate
- Local and self-hosted harness execution
- A generic stage/result contract
- An MCP server that exposes the harness to coding agents
- Logs, status, artifacts, and preview URL discovery

The repo-owned `.har/` directory remains the runtime contract. HAR should make it easy to scaffold and operate, but teams can edit it whenever their stack changes.

</details>

<details>
<summary><strong>Q: What does `har env init` create?</strong></summary>

**A:** It creates a `.har/` directory with scripts, docs, metadata, environment templates, and optional stage definitions for the current repo.

By default, `har env init` scaffolds boilerplate and prints a copy-paste prompt for your coding agent to adapt the harness and repo-root `AGENT.md`. Pass `--auto` to run built-in Claude adaptation instead (requires `ANTHROPIC_API_KEY`).

A typical harness includes scripts such as:

```bash
./.har/setup-infra.sh
./.har/launch.sh 1
./.har/verify.sh 1
./.har/teardown.sh 1
```

Advanced projects can add a stage registry such as `.har/stages.json`, plus stage scripts under `.har/stages/`.

</details>

<details>
<summary><strong>Q: Why keep `.har/` editable instead of hiding everything inside the CLI?</strong></summary>

**A:** Every serious codebase has local rules. Keeping `.har/` editable lets teams review the harness like normal code, customize it for their stack, and avoid being locked into HAR internals.

The CLI and MCP server provide stable control-plane behavior. The scripts remain project-owned.

</details>

<details>
<summary><strong>Q: What is the MCP server for?</strong></summary>

**A:** The MCP server lets agents operate the harness without hardcoding repo-specific shell commands.

Core MCP tools should cover durable operations:

- Describe the project and available stages
- Initialize or maintain `.har/`
- Launch and tear down an environment
- Run a generic stage by id or kind
- Read status and logs
- List artifacts, results, reports, screenshots, traces, and preview URLs

This keeps HAR focused on the harness/control-plane layer while other MCP servers can handle GitHub, Linear, observability, or chat integrations.

</details>

## Generic Stages

<details>
<summary><strong>Q: What is a HAR stage?</strong></summary>

**A:** A stage is a project-defined operation that HAR can run and report in a normalized way.

Examples of stage kinds include:

- `setup`
- `launch`
- `verify`
- `test`
- `inspect`
- `reset`
- `teardown`
- `custom`

Examples of stage ids include `unit`, `api-health`, `browser-e2e`, `migration-check`, `accessibility`, and `load-smoke`.

The core idea is generic: a stage has an id, a command, a status, a duration, logs, and optional artifacts or URLs.

</details>

<details>
<summary><strong>Q: Is Playwright a core HAR concept?</strong></summary>

**A:** No. Playwright is an optional stage template for browser workflows — HAR does not expose a hardcoded `run_playwright` MCP tool.

Add it with:

```bash
har env add-stage playwright
```

This registers a `browser-e2e` stage (`kind: test`) and scaffolds `@playwright/test` specs for frontend, API, and accessibility checks. Run it after launch:

```bash
./.har/launch.sh 1
./.har/stages/browser-e2e.sh 1
# or: har_run_stage(stageId: "browser-e2e", agentId: 1) via MCP
```

A Playwright workflow is just a `browser-e2e` stage that produces traces, screenshots, videos, and HTML reports under `.har/artifacts/browser-e2e/`.

</details>

<details>
<summary><strong>Q: Are migrations, accessibility checks, and load tests built in?</strong></summary>

**A:** They should be optional stage templates, not mandatory product assumptions.

Teams can add stages such as `migration-check`, `accessibility`, or `load-smoke` when those workflows matter. HAR runs them through the same generic stage/result contract as any other project operation.

</details>

<details>
<summary><strong>Q: What does a stage result contain?</strong></summary>

**A:** A normalized result should be machine-readable and useful for humans:

- Stage id and kind
- Status, such as passed, failed, skipped, or timed out
- Start time, end time, and duration
- Logs or log file references
- Artifacts, such as reports, traces, videos, screenshots, coverage, or JSON output
- Optional preview URLs or service endpoints
- Error summaries when something fails

This result can be consumed by agents, CLI output, PR comments, dashboards, or HAR Cloud.

</details>

## HAR Cloud

<details>
<summary><strong>Q: What is paid HAR Cloud for?</strong></summary>

**A:** HAR Cloud should sell hosted coordination and operational visibility, not replace the open-source harness.

Good paid features include:

- Hosted previews for branches and agent runs
- Run history across local, self-hosted, and hosted environments
- QA handoff, approval flows, and shareable preview links
- Slack, Linear, GitHub, and observability integrations
- Team dashboards for status and ownership
- Policy controls for what agents may run
- Audit trails for commands, outputs, approvals, and artifacts
- Cost controls for model usage, hosted compute, and repeated runs

</details>

<details>
<summary><strong>Q: Does HAR Cloud need to run all agent work?</strong></summary>

**A:** No. The first cloud product can coordinate and observe runs while the OSS harness executes locally, in CI-like infrastructure, or on self-hosted machines.

Hosted previews and remote runners are valuable paid features, but the core contract should remain portable.

</details>

<details>
<summary><strong>Q: Why would a team pay if the harness is open source?</strong></summary>

**A:** Teams can own their harness locally. They pay for the parts that become painful at team scale:

- Who ran what, when, and why?
- Which preview should QA open?
- Which artifacts prove the agent finished correctly?
- Did the run follow team policy?
- What did this agent workflow cost?
- How do Slack, Linear, GitHub, and observability updates stay in sync?

HAR Cloud should make the software factory easier to coordinate without taking ownership away from the repo.

</details>

## Workflow

<details>
<summary><strong>Q: What does a typical agent workflow look like?</strong></summary>

**A:** A generic flow looks like this:

```text
1. Agent reads AGENT.md and .har/README.md.
2. Agent or user asks HAR to describe available stages.
3. Agent launches an isolated environment.
4. Agent makes a code change.
5. Agent runs the relevant generic stages.
6. HAR returns normalized results, logs, artifacts, and URLs.
7. Agent fixes failures or hands off the run for review.
8. The environment is reset or torn down.
```

The exact stages are project-defined. HAR provides the contract and control plane.

</details>

<details>
<summary><strong>Q: Can humans use HAR too?</strong></summary>

**A:** Yes. Humans can run the same scripts and CLI commands as agents.

That is part of the value: the workflow is inspectable, reproducible, and not hidden inside an agent prompt.

</details>

<details>
<summary><strong>Q: What if my repo has a unique setup?</strong></summary>

**A:** Edit `.har/`.

HAR should scaffold a strong starting point, but the project owns the final harness. Add services, change ports, rewrite stage scripts, or define custom stages to match how your team actually works.

</details>

## Summary

HAR is the harness/control-plane layer for agent-first software development:

- OSS HAR: CLI, editable `.har/` scripts, MCP tools, generic stages, local/self-hosted execution
- Optional templates: Playwright, migrations, accessibility, load smoke tests, API checks, and other stack-specific workflows
- Paid HAR Cloud: hosted previews, run history, QA handoff, integrations, policy, audit, dashboards, and cost controls

The boundary is intentional: HAR makes repositories operable by agents without becoming the agent, the CI/CD system, or a hardcoded testing framework.
