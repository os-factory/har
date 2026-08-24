# __PLUGIN_ID__ (local HAR plugin)

Project-owned plugin scaffolded by `har plugin create __PLUGIN_ID__`. It lives in
`.har/plugins/__PLUGIN_ID__/` and is committed with the repository — HAR never
overwrites it on upgrade.

## Layout

| File | Purpose |
| --- | --- |
| `template.manifest.json` | What the plugin installs and which stages it registers |
| `stages/__PLUGIN_ID__.sh` | The stage script (HAR stage contract — see `.har/STAGES.md`) |
| `README.md` | This file — document what the stage checks and why |

## Develop

1. Implement the `TODO` block in `stages/__PLUGIN_ID__.sh`.
2. Install (or reinstall after changes) into the harness:

   ```bash
   har env add-plugin __PLUGIN_ID__ --force
   ```

   This copies the files listed in `template.manifest.json` into place and
   registers the plugin's stages in `.har/stages.json` — exactly like a
   bundled, npm, or git plugin.

3. Run it against a live slot:

   ```bash
   ./.har/stages/__PLUGIN_ID__.sh 1
   ```

For a simple one-liner check you may not need a plugin at all — register a
command stage directly in `.har/stages.json` (see `.har/STAGES.md`).

## Publish (optional)

The format is identical across all plugin sources — publishing requires zero
format changes:

- **npm**: add a `package.json` next to `template.manifest.json`, then
  `npm publish`. Consumers run `har env add-plugin @your-scope/__PLUGIN_ID__`.
- **git**: push this directory (manifest at the repo root, or under
  `plugins/__PLUGIN_ID__/`). Consumers run
  `har env add-plugin github:your-org/your-repo`.
