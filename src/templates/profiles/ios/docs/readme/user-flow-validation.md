## User-flow validation

Add the RocketSim plugin to get reusable UI flow validation:

```bash
har env add-plugin rocketsim
```

This installs `.har/stages/rocketsim-flows.sh` and a `flows/` directory. Add flow scripts under `flows/` (see `.har/stages/ROCKETSIM.md`). Full verify automatically runs all flows.
