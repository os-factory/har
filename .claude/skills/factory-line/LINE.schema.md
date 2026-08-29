# Line template contract (Phase 1)

A **line template** is data an agent (or a human) fills in to mint a factory
line. It is not wired into the CLI yet — Phase 2 (#304) should be able to lift
this file almost as-is into `.har/line.json`. Until then, the
[`factory-line` skill](./SKILL.md) reads it as the program.

`contractVersion: 1`. Additive fields are fine; renaming a field is a new
version.

## Design constraints (do not violate)

- A line **composes** things HAR 1.0 already has: work units, slots, stages,
  plugins, skills, MCP. It is not a fourth marketplace and not a second runner.
- A **station** is a named step. GitHub/Linear/none is a `work.source` on the
  station, not the type of the station.
- The **ratchet** is "every gate stage tagged ≤ current station still runs."
  The bash `case` in `.har/stages/fixture-e2e.sh` is a **prototype**, not this
  contract: later milestone arms there add questions but do not always re-enter
  earlier arms. Productize the *intent* (grow-only, never drop a station's
  stages), not the `case`.
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
| `extraStages` | no | Testing/verify/custom stages this line adds beyond the profile defaults. Phase 1: documentation only. Phase 2: registered stages. |
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

## Open decisions (Phase 2 — do not freeze here)

See epic #302. This contract is written so either answer still maps:

1. Per-repo `.har/line.json` vs tracker-as-source-of-truth — this file can live
   in-repo either way; tracker URLs stay on `work`.
2. Tagged stages vs a new `kind` — `gate.stages[].fromStation` *is* the tag.
3. Line vs plugin — this document **references** plugins; it is not one.
4. How MCP/skills are checked — Phase 1: agent preflight. Phase 2: `doctor` /
   `har line` preflight.
