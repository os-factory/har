# Line program contract

A **line program** is the data that defines a factory line. It is the
`line.json` inside an installable line bundle; installing that bundle
(`har line add <spec>`) puts it at `.har/lines/<id>/line.json`, which is what
the [`factory-line` skill](./SKILL.md) reads.

The `*.line.json` files under [`examples/`](./examples/) are **authoring
templates** — seeds for `har line create <id>` or for a fork of
[`os-factory/har-line`](https://github.com/os-factory/har-line) — not installed
programs.

`contractVersion: 1`. Additive fields are fine; renaming a field is a new
version.

## Design constraints (do not violate)

- A line **composes** things HAR already has: work units, slots, stages,
  plugins, skills, MCP. It is not a fourth marketplace and not a second runner:
  it reuses the plugin install channels (path → git → bundled id → npm) and the
  ordinary stage runner.
- A line is a **plugin-style bundle with a different apply path**. Installing
  one registers stages but **never** adds them to `verificationStages`. That is
  the whole reason the kinds are separate — a check that must gate every verify
  belongs in a verification plugin
  ([os-factory/har-plugin](https://github.com/os-factory/har-plugin)), not a
  line.
- A **station** is a named step. GitHub/Linear/none is a `work.source` on the
  station, not the type of the station.
- The **ratchet** is "every gate stage tagged ≤ current station still runs."
  `har line gate <station>` implements exactly that from this data. The bash
  `case` in `.har/stages/fixture-e2e.sh` was the **prototype**, not this
  contract: later milestone arms there add questions but do not always re-enter
  earlier arms.
- HAR does not install or copy third-party skill packs. `skills[]` are
  declarations + install hints. MCP entries are server names + why, never new
  core tools named after a tracker or a framework.
- Stacked PRs, a long-lived integration branch, `M0..M5` names, and a specific
  fixture repo are **instance data**. Put them on the line file, not in the
  skill.

## Document shape

JSON object. Comments in this markdown are normative; JSON files are the
instances.

```json
{
  "contractVersion": 1,
  "id": "kebab-id",
  "title": "Human title",
  "description": "What program this is, in one paragraph.",
  "skills": [
    {
      "id": "factory-line",
      "role": "orchestrator",
      "install": "repo:.claude/skills/factory-line"
    }
  ],
  "mcp": [
    {
      "name": "github",
      "why": "issue tracker and pull requests",
      "required": false
    }
  ],
  "plugins": ["playwright"],
  "stations": [
    {
      "id": "S1",
      "title": "First station",
      "description": "What this station produces.",
      "work": {
        "source": "github",
        "ids": ["123"],
        "optional": false
      },
      "waves": [
        [{ "workId": "123", "title": "optional override" }]
      ],
      "skills": ["optional-station-skill"],
      "mcp": ["github"]
    }
  ],
  "gate": {
    "cumulative": true,
    "optInEnv": null,
    "stages": [
      {
        "id": "browser-e2e",
        "fromStation": "S1",
        "tier": "full"
      }
    ]
  },
  "extraStages": [
    {
      "id": "example-gate",
      "kind": "test",
      "tier": "full",
      "description": "Line-owned check; Phase 2 installs this as a registered stage."
    }
  ],
  "handoff": {
    "autonomousShip": false,
    "waitFor": "human review before merge or release"
  },
  "traveler": {
    "kind": "github-issue-comment",
    "ref": "optional-stable-id",
    "note": "Where durable notes live given this repo's merge policy."
  },
  "prototypeNotes": [
    "Tactics this instance uses that are NOT part of the primitive."
  ]
}
```

## Field notes

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable kebab id. Becomes the line id in Phase 2. |
| `stations[].id` | yes | Stable id. Order in the array is station order. |
| `stations[].work` | no | Binding to a tracker. `source` is `github`, `linear`, `none`, or a free string. `ids` are work-unit ids to pass to `har env launch --work-id`. |
| `stations[].waves` | no | Each inner array is one **wave** (groups in a wave run in parallel). Each group is one agent / one HAR slot. If omitted, the station is a single sequential cell. |
| `skills` (root) | no | Skills the **line** expects. `role` is `orchestrator` or `station`. `install` is a hint (`repo:…`, `upstream:url`, `agent-managed`). |
| `mcp` | no | MCP **servers** the line expects. Declare, do not vendor. `required: false` means skip tracker steps if absent. |
| `plugins` | no | Plugin ids the gate needs (`har env add-plugin`). |
| `gate.cumulative` | yes | Must be `true` for a factory line. A QA station is never removed. |
| `gate.stages[].fromStation` | yes | This stage becomes required at this station **and every later station**. |
| `gate.optInEnv` | no | If set (e.g. `HAR_FIXTURE_E2E`), the gate is skipped unless that env is `1`, so routine verifies stay fast. |
| `extraStages` | no | Testing/verify/custom stages this line adds beyond the profile defaults. The bundle's `line.manifest.json` `stages[]` registers them at install — registered and runnable, never in `verificationStages`. |
| `handoff.autonomousShip` | yes | Must be `false`. Agents hand off; they do not merge or release. |
| `traveler` | no | Durable record that survives the repo's actual merge policy (squash drops `BREAKING CHANGE:` footers). |
| `prototypeNotes` | no | Instance tactics that must not leak into the primitive. |

## Growing the ratchet

Adding a station **must not** drop earlier `gate.stages`. To ask a new
question the previous gate forgot (prose vs scripts, CI vs local CLI version,
docs drift):

1. Add a stage (or a `doctor` check) that asks that question.
2. Tag it `fromStation` of the station that made the question askable.
3. Leave every earlier tag in place.

That is how #291 / #297 / #298 / #299 become permanent questions instead of
one-off review comments.

## Closed decisions

Settled in epic #302 / #304. Do not reopen without updating them:

1. **Per-repo installed bundle.** The program lives at
   `.har/lines/<id>/line.json`, with the install recorded in
   `.har/lines.json`. Tracker URLs stay on `stations[].work`.
2. **Tagged stages, not a new kind.** `gate.stages[].fromStation` *is* the tag.
   Tiers stay independent.
3. **Plugin-style bundle, separate apply.** A line installs through the plugin
   resolver but with its own apply path, which cannot patch
   `verificationStages`. `har env add-plugin` refuses a line bundle and
   `har line add` refuses a plugin manifest.
4. **Preflight.** `har line status` reports gate progress and any stage that
   leaked onto the verify plan; `har env doctor` fails on such a leak. Skill and
   MCP presence stay an agent preflight — HAR declares, it does not vendor.
