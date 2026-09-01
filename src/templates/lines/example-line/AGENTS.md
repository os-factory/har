# Authoring guide for coding agents

This repository is a **HAR factory line bundle**. Read this before changing it.

## Is this a line or a verification plugin?

Ask one question: **should this run on every `har env verify --full`?**

| Answer | Bundle kind | Template | Install |
|---|---|---|---|
| Yes — it must gate every change | Verification plugin | [har-plugin](https://github.com/os-factory/har-plugin) | `har env add-plugin <spec>` |
| No — it gates a *station* of a program | Factory line | this repo | `har line add <spec>` |

Typical lines: a migration executed in waves, an onboarding program, a
heavy proof jig (Docker lab, fixture end-to-end, device farm) that must exist
and be runnable but must not be on the hot path of every verify.

If you find yourself wanting to add a line stage to `verificationStages`, stop:
you wanted a plugin.

## Hard rules

- `line.manifest.json` declares `"kind": "line"` and **must not** declare
  `verificationStages`. The schema rejects it.
- `gate.cumulative` is `true`. A stage tagged `fromStation: X` is required at X
  **and every later station**. Adding a station may never drop an earlier
  station's stages.
- `handoff.autonomousShip` is `false`. Agents hand off; humans merge and
  release.
- `skills[]` and `mcp[]` are **declarations with install hints**. HAR does not
  vendor skill packs or MCP servers, and a line never introduces a core tool
  named after a tracker or a framework.
- Station names, tracker ids, branch strategy, and fixture repos are *instance
  data*. They belong in `line.json`, never in the tooling.

## Validate

```bash
node scripts/check-manifest.mjs
```

Then prove the invariant on a scratch harness:

```bash
har line add ./           # from a repo with a .har/ harness
har line status <id>
git diff -- .har/stages.json   # verificationStages must be untouched
```
