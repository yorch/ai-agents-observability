# syntax=docker/dockerfile:1.7

# ── Base ──────────────────────────────────────────────────────────────────────
FROM oven/bun:1.2-alpine AS base
WORKDIR /app

# ── Dependencies ──────────────────────────────────────────────────────────────
FROM base AS deps
COPY bun.lock package.json bunfig.toml ./
COPY packages/db/package.json packages/db/
COPY packages/schemas/package.json packages/schemas/
COPY apps/ingest/package.json apps/ingest/
RUN bun install --frozen-lockfile

# ── Build ─────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY packages/ packages/
COPY apps/ingest/ apps/ingest/
COPY tsconfig.base.json ./
RUN bun build apps/ingest/src/index.ts \
      --target bun \
      --outdir apps/ingest/dist \
      --external '@prisma/client'

# ── Production ────────────────────────────────────────────────────────────────
FROM oven/bun:1.2-alpine AS production
WORKDIR /app

RUN addgroup -S ingest && adduser -S ingest -G ingest
USER ingest

COPY --from=build --chown=ingest:ingest /app/apps/ingest/dist ./dist
COPY --from=deps --chown=ingest:ingest /app/node_modules ./node_modules

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/healthz || exit 1

CMD ["bun", "run", "dist/index.js"]
