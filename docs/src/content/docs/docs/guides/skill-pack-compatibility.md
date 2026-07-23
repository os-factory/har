---
title: Skill-pack compatibility
description: Compose HAR execution evidence with Matt Pocock's Skills and Superpowers.
---

HAR and methodology packs solve different problems:

- A skill pack decides how to clarify intent, plan, implement, debug, and review.
- HAR creates the isolated runtime and records what ran, what passed, and which
  exact tree was verified.

The composition rule is:

> When `.har/` is present, delegate worktree creation, app launch, final
> verification, and completion or teardown to HAR. Keep the methodology pack's
> planning, TDD, debugging, and review behavior.

HAR does not install, copy, or modify third-party skills. Install each upstream
project using its own instructions.

## Bind methodology output to work

Give every implementation ticket a stable identifier:

```bash
har env launch 1 \
  --work-id "github:acme/widget#123" \
  --work-source github \
  --work-url "https://github.com/acme/widget/issues/123" \
  --work-title "Add saved filters"
```

The launch creates a new attempt UUID. Runs, usage, telemetry, and exact-tree
validation are correlated to that attempt. A retry of the same work ID creates a
new attempt; parallel implementation should use child work IDs.

Finish successful work with `har env complete 1`. Plain teardown is cleanup and
does not mark the work complete.

## Matt Pocock's Skills

Install [mattpocock/skills](https://github.com/mattpocock/skills) from upstream.
Its requirements, issue, TDD, debugging, and review skills remain authoritative.

A compatible flow is:

1. Use the pack's grilling and requirements flow.
2. Produce or select one implementation issue.
3. Use that issue's provider-neutral key as `--work-id`.
4. Launch HAR before editing and work only in the returned directory.
5. Continue using the pack's implementation and review skills.
6. Run `har env verify <slot> --full`, then `har env complete <slot>`.

The issue tracker owns labels, priority, assignee, and workflow state. HAR stores
only stable correlation metadata and execution proof.

## Superpowers

Install [obra/superpowers](https://github.com/obra/superpowers) from upstream.
Keep `brainstorming`, `writing-plans`, TDD, debugging, execution, and review
behavior unchanged.

Current Superpowers worktree guidance already prefers native harness tooling when
available. In a HAR repository:

- `using-git-worktrees` should call `har env launch ...` and use its returned work
  directory; it must not create a second worktree.
- `finishing-a-development-branch` should call HAR full verification and
  `har env complete ...`; it must not remove HAR's worktree directly.

The rest of the methodology runs inside the HAR session.

## Compatibility boundary

| Concern | Owner |
| --- | --- |
| Requirements, decomposition, TDD, debugging, review | Human, tracker, or skill pack |
| Slot allocation, worktree, ports, database, app process | HAR |
| Runs, artifacts, telemetry, exact-tree validation | HAR |
| Merge, release, deployment policy | Repository and CI/CD |

This boundary avoids duplicated worktrees, conflicting cleanup, and a second issue
tracker hidden inside the harness.

## Reproducible showcase

The repository includes
[`examples/factory-showcase`](https://github.com/os-factory/har/tree/main/examples/factory-showcase),
a dependency-free application and one ticket that can be run through either
methodology. The fixture uses the same work ID and expected behavior so Mission
Control evidence can be compared without copying third-party skill content.
