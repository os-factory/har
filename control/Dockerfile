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
RUN npx prisma generate
RUN npm run build

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
# Reuse Prisma CLI from the builder (avoids a registry fetch in the runner stage).
COPY --from=builder /app/control/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/control/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/control/node_modules/.bin/prisma ./node_modules/.bin/prisma
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3847
# `prisma db push` creates the SQLite schema on first boot (idempotent after).
CMD ["sh", "-c", "npx prisma db push --skip-generate && node server.js"]
