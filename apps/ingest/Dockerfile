# syntax=docker/dockerfile:1.24

# ── Base ──────────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS base
WORKDIR /app
# keytar (transitive native dep via packages/auth) compiles via node-gyp during
# `bun install`; provide its build toolchain. This lives in the build-only stages
# (deps/build) and never reaches the production stage. keytar itself is loaded
# lazily with a try/catch fallback, so the runtime image needs no libsecret.
RUN apk add --no-cache build-base python3 libsecret-dev

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
COPY apps/ingest/ apps/ingest/
COPY tsconfig.base.json ./
# Generate Prisma client before bundling
RUN cd packages/db && bunx prisma generate
RUN bun build apps/ingest/src/index.ts \
      --target bun \
      --outdir apps/ingest/dist \
      --external '@prisma/client'

# ── Production ────────────────────────────────────────────────────────────────
FROM oven/bun:1.3.14-alpine AS production
WORKDIR /app

ARG APP_VERSION=dev
ARG COMMIT_HASH=unknown
ARG BUILD_TIME=unknown
ARG GIT_BRANCH=unknown
ARG GIT_TAG=
ARG GIT_TIMESTAMP=unknown
ARG BUILD_NUMBER=0
ENV APP_VERSION=${APP_VERSION} \
    COMMIT_HASH=${COMMIT_HASH} \
    BUILD_TIME=${BUILD_TIME} \
    GIT_BRANCH=${GIT_BRANCH} \
    GIT_TAG=${GIT_TAG} \
    GIT_TIMESTAMP=${GIT_TIMESTAMP} \
    BUILD_NUMBER=${BUILD_NUMBER}

RUN addgroup -S ingest && adduser -S ingest -G ingest
USER ingest

COPY --from=build --chown=ingest:ingest /app/apps/ingest/dist ./dist
COPY --from=build --chown=ingest:ingest /app/packages/db/src/generated ./packages/db/src/generated
COPY --from=deps --chown=ingest:ingest /app/node_modules ./node_modules

ENV NODE_ENV=production
EXPOSE 4000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:4000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["bun", "run", "dist/index.js"]
