---
title: Eject
description: har env eject — explicit runtime ownership for power users.
---

Most customization belongs in the
[customization contract](/docs/guides/customization/): config, stages, hooks,
plugins. But some teams genuinely want to own the runtime — audit it, patch it,
pin it forever. `har env eject` makes that explicit instead of leaving a
silently degraded fork.

```bash
har env eject
```

What it does:

- Vendors the packaged runtime (the same bundle `har` itself runs) into
  `.har/runtime/har.cjs`.
- Rewrites the `.har/*.sh` scripts to execute that vendored runtime directly
  with `node` — no `har` on PATH required, no npx network fallback. Argument
  conventions (`./.har/launch.sh 1`, `./.har/verify.sh 1 --full`) are
  unchanged.
- Records the ejection in `.har/manifest.json`.

From that point the scripts and vendored runtime are **user-owned**: drift and
`har env maintain` stop comparing them to upstream templates. `har env doctor`
keeps validating the contract (env schema, stage registry, slot registry) and
reports the ejected runtime as user-owned rather than flagging it as damage.

## Trade-offs

You take over upgrades: an ejected harness no longer picks up runtime fixes
from newer `@osfactory/har` releases until you re-eject or adopt. Config,
stages, hooks, and plugins keep working as before — the contract is the same.

## Reversing it

```bash
har env adopt
```

restores managed shims and removes `.har/runtime/` (as does
`har env init --force`). Nothing about your config surface is touched.

## When to eject

- Air-gapped or vendor-review environments that must not fetch from npm.
- Teams that need to patch runtime behavior HAR does not expose yet — consider
  filing an issue too; hooks or plugins may already cover the need.
- During [0.x → 1.0 migration](/docs/guides/migrating-to-1-0/), when a heavily
  customized harness is not worth lifting into the contract yet.
