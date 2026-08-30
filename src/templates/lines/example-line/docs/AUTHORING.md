# Authoring a factory line

## 1. The program (`line.json`)

`contractVersion: 1`. Additive fields are fine; renaming a field is a new
version.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable kebab id. Must match `line.manifest.json`. |
| `title` | yes | Human title. |
| `stations[]` | yes | Ordered. Array order *is* station order. |
| `stations[].id` | yes | Stable, shell-friendly. |
| `stations[].work` | no | Tracker binding: `source` (`github`, `linear`, `none`, …), `ids[]` passed to `har env launch --work-id`. |
| `stations[].waves` | no | Each inner array is one wave; cells in a wave run in parallel slots. |
| `skills[]` | no | Skills the line expects. `role` is `orchestrator` or `station`; `install` is a hint (`repo:…`, `upstream:url`, `agent-managed`). |
| `mcp[]` | no | MCP **servers** the line expects. `required: false` means skip those steps when absent. |
| `plugins[]` | no | Verification plugin ids the gate assumes (`har env add-plugin`). |
| `gate.cumulative` | yes | Must be `true`. |
| `gate.optInEnv` | no | When set (e.g. `HAR_FIXTURE_E2E`), the gate is skipped unless that env is `1`. |
| `gate.stages[].fromStation` | yes | The ratchet tag: required from this station onward. |
| `extraStages[]` | no | Stages this line adds beyond the profile defaults. |
| `handoff.autonomousShip` | yes | Must be `false`. |
| `traveler` | no | Where durable notes live given the repo's merge policy. |
| `prototypeNotes[]` | no | Instance tactics that must not leak into the primitive. |

## 2. The manifest (`line.manifest.json`)

```json
{
  "kind": "line",
  "id": "your-line",
  "program": "line.json",
  "files": [
    { "src": "stages/your-gate.sh", "dest": ".har/stages/your-gate.sh", "executable": true }
  ],
  "stages": [{ "id": "your-gate", "kind": "test", "script": "stages/your-gate.sh", "tier": "full" }]
}
```

- `files[]` are copied into the target repo verbatim.
- `stages[]` are **registered** in `.har/stages.json` — and nothing else. They
  are not appended to `verificationStages`, and the CLI refuses to write if
  applying the bundle would have moved that list.
- Declaring `verificationStages` here is a schema error, not a warning.

## 3. The gate stage

A line stage is an ordinary HAR stage script: stdout is one JSON result object,
stderr is progress, `$1` is the agent slot id, artifacts go under
`.har/artifacts/<stage-id>/`. See `.har/STAGES.md` in any harness for the full
contract.

Run it through the line, not through verify:

```bash
har line gate S2 --line your-line
```

## 4. Growing the ratchet

To ask a question the previous gate forgot:

1. Add a stage (or a `doctor` check) that asks it.
2. Tag it `fromStation` of the station that made the question askable.
3. Leave every earlier tag in place.

That is how a review comment becomes a permanent question instead of a habit.

## 5. Publish

```bash
git init && git commit -am "feat: my line"
gh repo create your-org/your-line --public --source . --push
```

Consumers install with `har line add github:your-org/your-line`. For npm, keep
`package.json` and `npm publish` — `har line add @your-org/your-line` packs it
with `npm pack` and reads `line.manifest.json` from the package root.
