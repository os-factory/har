## User-flow validation (RocketSim)

If the RocketSim plugin is installed (`har env add-plugin rocketsim`):

```bash
./.har/stages/rocketsim-flows.sh ${AGENT_ID}
# included in:
./.har/verify.sh ${AGENT_ID} --full
```

Add and edit user flow scripts in `flows/`. Read `.har/stages/ROCKETSIM.md` for the full authoring guide.
