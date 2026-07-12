# HAR documentation site

The public documentation is an [Astro Starlight](https://starlight.astro.build/)
static site deployed to GitHub Pages at:

<https://os-factory.github.io/har/>

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
```

`drift` compares documented public contracts with the CLI, MCP, schemas, templates,
profiles, and managed skills. The root HAR full-verification pipeline and pull-request
workflow run all three commands.

## Deployment

`.github/workflows/docs.yml` builds the site on pull requests and deploys pushes to
`main` through GitHub Pages. In repository settings, set **Pages → Build and
deployment → Source** to **GitHub Actions** once.

The Astro `site` and `base` values target the `os-factory/har` project page. Update
both if the repository moves or a custom domain is introduced.

Documentation content is licensed under
[CC BY-SA 4.0](../DOCUMENTATION-LICENSE.md).
