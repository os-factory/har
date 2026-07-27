# HAR website & documentation

The public site is an [Astro](https://astro.build/) project deployed to GitHub
Pages at <https://harproject.dev/>:

- `/` — marketing landing page with interactive workflow hero
- `/blog` — journal index and articles
- `/docs` — Starlight documentation (same content as before, new theme)

## Local development

Node.js 22.12 or newer is required (Astro 7).

```bash
npm ci
npm run dev
```

From the repository root, prefer launching a HAR slot first and work in the returned
session worktree.

## Verification

```bash
npm run drift
npm run check
npm run build
npm run links
```

`drift` compares documented public contracts with the CLI, MCP, schemas, templates,
profiles, and managed skills. The root HAR full-verification pipeline and pull-request
workflow run all three commands.

## Deployment

`.github/workflows/docs.yml` builds the site on pull requests and deploys pushes to
`main` through GitHub Pages. In repository settings, set **Pages → Build and
deployment → Source** to **GitHub Actions** once.

The Astro `site` and `base` values target the custom domain `harproject.dev`.
Update both if the domain or Pages path changes.

Documentation content is licensed under
[CC BY-SA 4.0](../DOCUMENTATION-LICENSE.md).

## Source layout

- `src/pages/index.astro` — landing page
- `src/pages/blog/` — journal pages
- `src/content/docs/docs/` — documentation (served under `/docs`)
- `src/styles/global.css` — landing/blog theme
- `src/styles/custom.css` — Starlight theme overrides
