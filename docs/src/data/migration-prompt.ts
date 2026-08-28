/** Starter prompt to paste into a coding agent. `har env maintain` then writes a repo-specific `.har/MIGRATE-PROMPT.md`. */
export const MIGRATION_PROMPT = `Migrate this repository's .har/ harness from the pre-1.0 shape to HAR 1.0.0.

Follow the operator guide: https://harproject.dev/docs/guides/migrating-to-1-0/

1. Install the current CLI: npm install -g @osfactory/har@latest
2. From the directory that owns .har/, run: har env maintain
   That detects the pre-1.0 layout and writes .har/MIGRATE-PROMPT.md with this repo's residue.
3. Read and execute .har/MIGRATE-PROMPT.md in this session.
   - Run har env maintain --migrate for the mechanical steps (shims, harness.env, deleted vendored machinery).
   - Lift any adapted residue into harness.env, stages.json, .har/hooks/, or a local plugin as the prompt describes.
   - Do not edit generated .har/*.sh shims or .har/manifest.json.
4. Finish green: har env doctor must pass, then har env launch 1 && har env verify 1 --full.
5. Record the migration: har env maintain --finalize --summary "Migrated to the 1.0 config surface"

If the harness is too deeply patched to lift, use har env eject instead — the guide covers that path.
`;
