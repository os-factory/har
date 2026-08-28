# HAR website & documentation

The public site is an [Astro](https://astro.build/) project deployed to GitHub
Pages at <https://harproject.dev/>:

- `/` — marketing landing page with interactive workflow hero
- `/blog/` — journal index; articles under `/blog/<slug>/` (`/blog/har-1-0-0/`, `/blog/the-factory-line/`)
- `/docs` — Starlight documentation (same content as before, new theme)

## Agent harness

Isolated agent slots live in [`.har/`](.har/README.md). Prefer that path for live
preview, Playwright, and before/after screenshots:

```bash
cd docs
har env launch 1
har env verify 1 --full   # includes browser-e2e + screenshots under .har/artifacts/
```

See [AGENTS.md](./AGENTS.md). This is one of three harnesses in the monorepo
(root CLI, Mission Control, docs) — indexed in the root [`AGENTS.md`](../AGENTS.md).

## Local development

Node.js 22.12 or newer is required (Astro 7).

```bash
npm ci
npm run dev
```

Prefer launching a HAR slot first and work in the returned session worktree.

## Verification

```bash
npm run drift
npm run check
npm run build
npm run links
npm run test:e2e   # requires a running site + BASE_URL; prefer harness full verify
```

`drift` compares documented public contracts with the CLI, MCP, schemas, templates,
profiles, and managed skills. Harness full verify runs check/drift/build/links plus
Playwright with screenshot artifacts.

## Deployment

`.github/workflows/docs.yml` builds the site on pull requests and deploys pushes to
`main` through GitHub Pages. In repository settings, set **Pages → Build and
deployment → Source** to **GitHub Actions** once.

The Astro `site` and `base` values target the custom domain `harproject.dev`.
Update both if the domain or Pages path changes.

Documentation content is licensed under the
[Apache License 2.0](../LICENSE), the same as the rest of the project.

## Source layout

- `src/pages/index.astro` — landing page
- `src/pages/blog/` — journal index and article routes
- `src/content/blog/` — journal markdown
- `src/content/docs/docs/` — documentation (served under `/docs`)
- `src/styles/global.css` — landing/blog theme
- `src/styles/custom.css` — Starlight theme overrides
