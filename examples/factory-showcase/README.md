# HAR Factory showcase

This dependency-free Node application is a reproducible compatibility fixture. The
sample ticket is:

> `DEMO-1`: Saved filter names must be unique, ignoring case.

The checked-in implementation and tests are intentionally small so the methodology
can change while HAR evidence stays comparable.

## Prepare

Copy this directory to a temporary Git repository, then install and adapt the CLI
profile:

```bash
git init
git add .
git commit -m "chore: seed showcase"
har onboard --yes --profile cli --no-control --no-plugins
# Adapt verify.sh so full verification runs: npm test
git add .har
git commit -m "chore: add HAR harness"
```

Install either methodology from its upstream repository:

- [Matt Pocock's Skills](https://github.com/mattpocock/skills)
- [Superpowers](https://github.com/obra/superpowers)

Do not copy either project's skill bodies into this fixture.

## Run with either methodology

Use the methodology to clarify and review `DEMO-1`. At the point it asks for an
isolated implementation environment, bind the same work identity:

```bash
har env launch 1 \
  --work-id DEMO-1 \
  --work-source local \
  --work-title "Unique saved filter names"
```

Make the methodology's implementation inside the returned work directory, then:

```bash
har env verify 1 --full
git add -A
git commit -m "feat: enforce unique saved filter names"
har env complete 1
```

Mission Control should show:

`DEMO-1 → attempt → verify run → exact-tree validation → completed`

Repeat from the seed commit with the other methodology. Planning and review
evidence will differ; HAR's work/attempt/evidence contract remains the same.
