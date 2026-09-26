---
title: A skill is not a gate
description: The verify skill lets the model say the check passed. HAR runs the check and keeps the exit code, even when the model wrote the test.
date: 2026-09-26
kicker: Method
---

<div class="video-embed">
<iframe src="https://www.youtube.com/embed/mQZB0l-rhxE" title="Building verification loops in Claude Code" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen loading="lazy"></iframe>
</div>

[Building verification loops in Claude Code](https://www.youtube.com/watch?v=mQZB0l-rhxE). Docs: [give Claude a way to verify its work](https://code.claude.com/docs/en/best-practices#give-claude-a-way-to-verify-its-work), [`/verify`](https://code.claude.com/docs/en/skills#run-and-verify-your-app).

Tests, types, and lint already run. They do not prove the Like button works. The video says to write down the check you do afterwards: open the page, click, read the console, measure the layout shift. Claude saves that as a skill, runs it, and reports that the trace passed.

The report is the weak part. A skill is a prompt in `.claude/skills/`. The same session reads the screenshot, decides the score is fine, and can edit the skill when a run went badly. The proof stays in that chat. Cursor and Codex never load the file.

HAR does not dodge who writes the check. The agent writes the Playwright spec too. A test that clicks nothing and still passes is a bad test, and it is sitting in the diff where you can reject it.

What the agent does not get is the grade. [`browser-e2e`](/docs/guides/plugins/) is a stage. It exits 0 or it does not. Full verify stores that exit against the git tree. The [commit gate](/docs/guides/verification/) refuses a staged batch that never passed, and `har env complete` reuses the green run only while the tree hash still matches. Claude, Cursor, and Codex hit the same stages.

| Verify skill | HAR |
| --- | --- |
| The model reads the trace and says it passed. | The stage exits. The run record stores the exit against the tree. |
| Screenshots live in the chat. | A later edit invalidates the validation. |
| Runs when the skill description matches, in Claude Code. | `har env verify`, for whichever agent is in the slot. |

A layout-shift budget fits in that registry: a stage that fails when the score crosses the line you set. The agent can read the failure and fix the jump. It cannot talk a red stage into a pass.
