---
title: Introduction
description: What HAR solves and where it fits in an agent development workflow.
---

HAR is an open-source, agent-agnostic framework for building multi-agent coding
workflows. Run a fleet of coding agents in parallel on any repository, with
deterministic validation gates, verifiable proof, and full observability across
every agent, all extensible and customizable to your own workflow and tooling.

<div class="intro-video">
<video src="/assets/introduction-har.mp4" controls preload="metadata" playsinline title="HAR introduction demo">
Sorry, your browser does not support embedded video. <a href="/assets/introduction-har.mp4">Download the demo</a>.
</video>
</div>

<div class="next-steps">
<a class="next-card" href="/docs/getting-started/installation/">
<span class="next-title"><span>Install HAR</span><span class="next-arrow" aria-hidden="true">&rarr;</span></span>
<span class="next-desc">Get the CLI and MCP server running in your environment.</span>
</a>
<a class="next-card" href="/docs/getting-started/quick-start/">
<span class="next-title"><span>Quick start</span><span class="next-arrow" aria-hidden="true">&rarr;</span></span>
<span class="next-desc">Scaffold the harness, launch an isolated slot, and run your first verification.</span>
</a>
<a class="next-card" href="/docs/getting-started/concepts/">
<span class="next-title"><span>Core concepts</span><span class="next-arrow" aria-hidden="true">&rarr;</span></span>
<span class="next-desc">Learn the terms the rest of the docs build on, from harness and slot to stage, run, and validation.</span>
</a>
</div>

## The problems HAR solves

Getting a single coding agent to work in a repo is easy. Scaling that into a real
multi-agent workflow, where several agents run at once and humans still trust the
output, is where it breaks down. HAR was built to close those gaps:

1. **No standard way to run or verify a repo.** That knowledge is scattered across a
   README, a CLAUDE.md, Cursor rules, and CI yaml today, drifting out of sync with
   each other and the actual codebase. HAR replaces all of that with one
   machine-readable contract (`.har/`) that Claude Code, Cursor, Codex, or any MCP
   agent reads the same way.
2. **Multiple agents on one repo collide.** Shared dev server, shared database,
   shared ports, conflicting Git state. HAR gives each agent its own worktree, ports,
   and database per slot, so a fleet can genuinely run concurrently.
3. **Trusting an agent's change means re-verifying it yourself.** Every task runs the
   same deterministic verify step and leaves an evidence trail, logs, artifacts, and a
   validated tree hash, so a reviewer can check proof of what ran instead of relying on
   the agent's self-report.
4. **One platform's sandbox locks you in.** If the contract lives inside a vendor's
   hosted dashboard, switching coding agents later means rebuilding the whole
   verification setup. HAR's contract is an open standard living in the repo itself,
   portable across whichever agent or tool you adopt.
5. **Hand-rolled scripts rot as the stack changes.** A new dependency, a new service, a
   new env var, and nobody updates the script until an agent's run fails for a confusing
   reason. `har env maintain` diffs your installed harness against current templates and
   flags drift before it causes a silent failure.

HAR coordinates the work around the model, so agents can focus on the code and
reviewers can trust the result.

## What HAR gives you

HAR gives a fleet of agents everything it needs to run, verify, and hand off
work you can trust.

<div class="what-grid">
<a class="what-cell" href="/docs/getting-started/concepts/">
<svg class="what-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/></svg>
<span class="what-title">Isolated slots</span>
<p>Each agent works in its own worktree with dedicated ports and a database, so the main checkout stays clean.</p>
</a>
<a class="what-cell" href="/docs/guides/verification/">
<svg class="what-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/></svg>
<span class="what-title">Deterministic checks</span>
<p>The project's real checks run through the same pipeline every time and return a consistent result.</p>
</a>
<a class="what-cell" href="/docs/guides/stages/">
<svg class="what-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v5h5"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>
<span class="what-title">Evidence trail</span>
<p>Every run can leave logs, artifacts, and a validated tree hash tied to the exact code that was checked.</p>
</a>
<a class="what-cell" href="/docs/reference/harness-files/">
<svg class="what-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10 12.5-2 2.5 2 2.5"/><path d="m14 12.5 2 2.5-2 2.5"/><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>
<span class="what-title">One contract</span>
<p>A machine-readable .har/ folder that Claude Code, Cursor, Codex, and any MCP agent read the same way.</p>
</a>
<a class="what-cell" href="/docs/guides/mission-control/">
<svg class="what-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>
<span class="what-title">Mission Control</span>
<p>A local dashboard for every repository, worktree, run, validation, and artifact across your projects.</p>
</a>
<a class="what-cell" href="/docs/guides/plugins/">
<svg class="what-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="7" height="7" x="14" y="3" rx="1"/><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3"/></svg>
<span class="what-title">Plugins</span>
<p>Extend the harness with framework-specific stages like Playwright, or build your own.</p>
</a>
</div>

## Open source and portable

The CLI, MCP server, harness runtime, and local Mission Control are open source.
The `.har/` directory remains in your repository and is editable even if you stop
using HAR's CLI.
