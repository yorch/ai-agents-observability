# syntax=docker/dockerfile:1.24

# ── Base ──────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app

# ── Dependencies ──────────────────────────────────────────────────────────────
FROM base AS deps
COPY bun.lock package.json bunfig.toml ./
COPY apps/github-app/package.json apps/github-app/
COPY apps/hook/package.json apps/hook/
COPY apps/ingest/package.json apps/ingest/
COPY apps/web/package.json apps/web/
COPY packages/auth/package.json packages/auth/
COPY packages/db/package.json packages/db/
COPY packages/github/package.json packages/github/
COPY packages/redaction/package.json packages/redaction/
COPY packages/schemas/package.json packages/schemas/
RUN bun install --frozen-lockfile

# ── Build ─────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY packages/ packages/
COPY apps/github-app/ apps/github-app/
COPY tsconfig.base.json ./
# Generate Prisma client before bundling
RUN cd packages/db && bunx prisma generate
RUN bun build apps/github-app/src/index.ts \
      --target bun \
      --outdir apps/github-app/dist \
      --external '@prisma/client'

# ── Production ────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS production
WORKDIR /app

RUN addgroup -S github-app && adduser -S github-app -G github-app
USER github-app

COPY --from=build --chown=github-app:github-app /app/apps/github-app/dist ./dist
COPY --from=build --chown=github-app:github-app /app/packages/db/src/generated ./packages/db/src/generated
COPY --from=deps --chown=github-app:github-app /app/node_modules ./node_modules

ENV NODE_ENV=production
EXPOSE 4001

HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4001/health || exit 1

CMD ["bun", "run", "dist/index.js"]
