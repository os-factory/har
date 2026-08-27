## User-flow validation (RocketSim)

If the RocketSim plugin is installed (`har env add-plugin rocketsim`):

```bash
./.har/stages/rocketsim-flows.sh <id>
# included in:
har env verify <id> --full
```

Add and edit user flow scripts in `flows/`. Read `.har/stages/ROCKETSIM.md` for the full authoring guide.
