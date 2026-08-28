## Maintaining this harness

When the project stack changes (new services, different test commands, new env vars):

```bash
har env maintain
```

The authoring agent reconciles the config surface and this README. Review changes before committing.

Customize through the contract — config (`harness.env`), stages (`stages.json` +
`stages/`), hooks (`hooks/`), plugins (`plugins/`). The `*.sh` files are generated
shims over the packaged runtime: don't edit them (`har env eject` exists for full
ownership). `har env doctor` validates the result.
