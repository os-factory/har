FROM node:20-alpine AS deps
WORKDIR /app
COPY packages/schemas ./packages/schemas
RUN npm install --prefix packages/schemas --omit=dev
WORKDIR /app/control
COPY control/package.json control/package-lock.json* ./
RUN npm install

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
COPY --from=builder /app/control/public ./public
COPY --from=builder /app/control/.next/standalone ./
COPY --from=builder /app/control/.next/static ./.next/static
COPY --from=builder /app/control/prisma ./prisma
# Pin Prisma CLI (devDependency at build time; npx would fetch Prisma 7+).
RUN npm install prisma@6.19.3 --omit=dev
EXPOSE 3847
CMD ["sh", "-c", "npx prisma db push && node server.js"]
