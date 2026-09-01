## Maintaining this harness

When the project stack changes (new services, different test commands, new env vars):

```bash
har env maintain
```

The authoring agent reconciles the config surface and this README. Review changes before committing.

Customize through the contract — config (`harness.env`), stages (`stages.json` +
`stages/`), hooks (`hooks/`), plugins (`plugins/`). Drive the harness with
`har env …` or MCP. `har env eject` vendors `.har/runtime/` for offline ownership.
`har env doctor` validates the result.
