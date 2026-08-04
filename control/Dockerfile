FROM node:20-alpine AS deps
ENV npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false
WORKDIR /app
# Copy package manifests only so source edits don't invalidate npm install layers.
COPY packages/schemas/package.json packages/schemas/package-lock.json ./packages/schemas/
RUN --mount=type=cache,target=/root/.npm \
  npm ci --prefix packages/schemas --omit=dev
WORKDIR /app/control
COPY control/package.json control/package-lock.json ./
# Schemas deps are installed above; skip control postinstall re-install.
RUN --mount=type=cache,target=/root/.npm \
  npm ci --ignore-scripts

FROM node:20-alpine AS builder
WORKDIR /app
COPY packages/schemas ./packages/schemas
COPY --from=deps /app/packages/schemas/node_modules ./packages/schemas/node_modules
COPY control ./control
WORKDIR /app/control
COPY --from=deps /app/control/node_modules ./node_modules
# Public PostHog client token, inlined into the client bundle at build time by Next.js.
ENV NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=phc_Btprma6YFgCEh22DcBWUJTf7YLWMrEymWmCWxeRGUsJG
ENV NEXT_PUBLIC_POSTHOG_HOST=https://eu.i.posthog.com
RUN npx prisma generate
RUN npm run build

# Full Prisma CLI install (package + transitive deps like `effect`). Kept as its own
# stage so the runner can merge it without a registry fetch, and so we can recreate
# `.bin/prisma` as a symlink (Docker COPY dereferences symlinks).
FROM node:20-alpine AS prisma-cli
ENV npm_config_audit=false \
    npm_config_fund=false \
    npm_config_update_notifier=false
WORKDIR /prisma
# Pin to the version locked in control/package-lock.json.
RUN --mount=type=cache,target=/root/.npm \
  npm install prisma@6.19.3 --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3847
# Self-contained SQLite database — lives on a persistent volume so no external
# database (and no docker-compose) is required to run Mission Control.
ENV DATABASE_URL=file:/data/har_control.db
COPY --from=builder /app/control/public ./public
COPY --from=builder /app/control/.next/standalone ./
COPY --from=builder /app/control/.next/static ./.next/static
COPY --from=builder /app/control/prisma ./prisma
# Merge Prisma CLI + transitive deps into the Next standalone tree.
# - Skip `.bin` from COPY (Docker materializes the prisma symlink as a file, so the
#   CLI resolves wasm next to itself under `.bin/` → ENOENT on boot).
# - Keep the generated client under `node_modules/.prisma` and `@prisma/client`.
COPY --from=prisma-cli /prisma/node_modules /tmp/prisma-cli-modules
RUN set -eux; \
  mkdir -p node_modules/.bin; \
  if [ -d node_modules/.prisma ]; then cp -a node_modules/.prisma /tmp/keep-prisma-generated; fi; \
  if [ -d node_modules/@prisma/client ]; then cp -a node_modules/@prisma/client /tmp/keep-prisma-client; fi; \
  for entry in /tmp/prisma-cli-modules/*; do \
    name="$(basename "$entry")"; \
    [ "$name" != ".bin" ] || continue; \
    if [ "$name" = "@prisma" ]; then \
      mkdir -p node_modules/@prisma; \
      for pkg in "$entry"/*; do \
        pkgname="$(basename "$pkg")"; \
        [ "$pkgname" != "client" ] || continue; \
        rm -rf "node_modules/@prisma/$pkgname"; \
        cp -a "$pkg" "node_modules/@prisma/$pkgname"; \
      done; \
      continue; \
    fi; \
    rm -rf "node_modules/$name"; \
    cp -a "$entry" "node_modules/$name"; \
  done; \
  if [ -d /tmp/keep-prisma-generated ]; then \
    rm -rf node_modules/.prisma; \
    cp -a /tmp/keep-prisma-generated node_modules/.prisma; \
  fi; \
  if [ -d /tmp/keep-prisma-client ]; then \
    rm -rf node_modules/@prisma/client; \
    mkdir -p node_modules/@prisma; \
    cp -a /tmp/keep-prisma-client node_modules/@prisma/client; \
  fi; \
  ln -sfn ../prisma/build/index.js node_modules/.bin/prisma; \
  rm -rf /tmp/prisma-cli-modules /tmp/keep-prisma-generated /tmp/keep-prisma-client; \
  test -L node_modules/.bin/prisma; \
  test -f node_modules/prisma/build/prisma_schema_build_bg.wasm; \
  test -d node_modules/effect; \
  test -f node_modules/.prisma/client/index.js
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3847
# `prisma db push` creates the SQLite schema on first boot (idempotent after).
CMD ["sh", "-c", "npx prisma db push --skip-generate && node server.js"]
