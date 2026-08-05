---
title: Contributing
description: Develop and validate HAR itself.
---

The full contributor guide lives in the repository:

**[CONTRIBUTING.md on GitHub](https://github.com/os-factory/har/blob/main/CONTRIBUTING.md)**

That document covers setup, architecture layers, the dogfood harness loop, commit conventions, and where to put changes. Coding agents should also read [AGENTS.md](https://github.com/os-factory/har/blob/main/AGENTS.md). Maintainer release mechanics are in [RELEASING.md](https://github.com/os-factory/har/blob/main/RELEASING.md).

## Short version

```bash
git clone https://github.com/os-factory/har.git
cd har
npm install
npm run build
```

Node.js 20 or newer is required. Docker is required for Mission Control and fixture harnesses that use shared infrastructure.

This repository dogfoods two harnesses:

| Harness | Owns |
| --- | --- |
| root `.har/` (`cli` profile) | CLI, MCP, schemas, templates, and tests |
| `control/.har/` (`default` profile) | Mission Control Next.js app and browser tests |

Launch the harness that owns the files **before** editing, make all changes in the printed work directory, and run full verification before declaring work complete:

```bash
har env launch 1
# edit only under the printed work dir
har env verify 1 --full
```

If the commit gate is installed, commits must match a tree that passed full verify.

Public CLI, MCP, schema, and template changes must keep the docs contract green (`npm run drift --prefix docs`, also run as `docs-drift` during full verify).

Read the repository's Code of Conduct, security policy, and [LICENSE](https://github.com/os-factory/har/blob/main/LICENSE) before submitting changes.
